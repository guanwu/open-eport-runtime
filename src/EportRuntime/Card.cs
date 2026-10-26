// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace EportRuntime;

public sealed record CardDevice(
  string Name,
  string DeviceId,
  string CertificateId);

public sealed record CardSignature(string Algorithm, byte[] Bytes);

// Direct bindings to the statically linked eportskf engine. Struct layouts mirror
// the C ABI, and every returned string is UTF-8 owned by the engine until the
// matching free call.
internal static unsafe class CardNative
{
  public const int Ok = 0;
  public const int UnusableArgument = 1;
  public const int DeviceUnavailable = 2;
  public const int PinRejected = 3;
  public const int VerificationRequired = 4;

  public const int SignatureSm2 = 1;
  public const int SignatureRsaSha1 = 2;

  public const int MaxSignatureBytes = 128;

  [StructLayout(LayoutKind.Sequential)]
  public struct Identity
  {
    public IntPtr CertificateId;
    public IntPtr DeviceId;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct DeviceInfo
  {
    public IntPtr Name;
    public Identity Identity;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct DeviceList
  {
    public IntPtr Items;
    public nuint Count;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Signature
  {
    public int Algorithm;
    public nuint Length;
    public fixed byte Bytes[MaxSignatureBytes];
  }

  [DllImport("eportskf", EntryPoint = "eportskf_enumerate", CallingConvention = CallingConvention.Cdecl)]
  public static extern int Enumerate(out DeviceList devices);

  [DllImport("eportskf", EntryPoint = "eportskf_free_device_list", CallingConvention = CallingConvention.Cdecl)]
  public static extern void FreeDeviceList(ref DeviceList devices);

  [DllImport("eportskf", EntryPoint = "eportskf_open", CallingConvention = CallingConvention.Cdecl)]
  public static extern int Open(
    [MarshalAs(UnmanagedType.LPUTF8Str)] string name,
    out IntPtr device);

  [DllImport("eportskf", EntryPoint = "eportskf_close", CallingConvention = CallingConvention.Cdecl)]
  public static extern int Close(IntPtr device);

  [DllImport("eportskf", EntryPoint = "eportskf_read_identity", CallingConvention = CallingConvention.Cdecl)]
  public static extern int ReadIdentity(IntPtr device, out Identity identity);

  [DllImport("eportskf", EntryPoint = "eportskf_free_identity", CallingConvention = CallingConvention.Cdecl)]
  public static extern void FreeIdentity(ref Identity identity);

  [DllImport("eportskf", EntryPoint = "eportskf_verify_pin", CallingConvention = CallingConvention.Cdecl)]
  public static extern int VerifyPin(IntPtr device, IntPtr pin);

  [DllImport("eportskf", EntryPoint = "eportskf_sign_start", CallingConvention = CallingConvention.Cdecl)]
  public static extern int SignStart(IntPtr device);

  [DllImport("eportskf", EntryPoint = "eportskf_sign_update", CallingConvention = CallingConvention.Cdecl)]
  public static extern int SignUpdate(IntPtr device, IntPtr data, nuint length);

  [DllImport("eportskf", EntryPoint = "eportskf_sign_finish", CallingConvention = CallingConvention.Cdecl)]
  public static extern int SignFinish(IntPtr device, out Signature signature);

  [DllImport("eportskf", EntryPoint = "eportskf_sign_abort", CallingConvention = CallingConvention.Cdecl)]
  public static extern int SignAbort(IntPtr device);

  [DllImport("eportskf", EntryPoint = "eportskf_result_description", CallingConvention = CallingConvention.Cdecl)]
  private static extern IntPtr ResultDescription(int result);

  public static string Describe(int result) =>
    Marshal.PtrToStringUTF8(ResultDescription(result)) ?? string.Empty;
}

// Owns the agent-wide card slot. One request may use a card at a time; native
// work runs on the thread pool so a slow card never blocks a session, and
// verify and sign open and close their own device.
public sealed class CardService
{
  private const int ChunkSize = 64 * 1024;

  private readonly SemaphoreSlim _slot = new(1, 1);

  public async Task<IReadOnlyList<CardDevice>> ListAsync(CancellationToken cancellationToken)
  {
    await _slot.WaitAsync(cancellationToken);
    try
    {
      var devices = await Task.Run(ListCore, cancellationToken);
      cancellationToken.ThrowIfCancellationRequested();
      return devices;
    }
    finally
    {
      _slot.Release();
    }
  }

  public async Task VerifyAsync(
    string device,
    string deviceId,
    string pin,
    CancellationToken cancellationToken)
  {
    await _slot.WaitAsync(cancellationToken);
    try
    {
      var pinBuffer = EncodePin(pin);
      try
      {
        await Task.Run(() => VerifyCore(device, deviceId, pinBuffer), cancellationToken);
      }
      finally
      {
        CryptographicOperations.ZeroMemory(pinBuffer);
      }

      cancellationToken.ThrowIfCancellationRequested();
    }
    finally
    {
      _slot.Release();
    }
  }

  public async Task<CardSignature> SignAsync(
    string device,
    string deviceId,
    string pin,
    string messagePath,
    CancellationToken cancellationToken)
  {
    await _slot.WaitAsync(cancellationToken);
    try
    {
      var pinBuffer = EncodePin(pin);
      try
      {
        var signature = await Task.Run(
          () => SignCore(device, deviceId, pinBuffer, messagePath, cancellationToken),
          cancellationToken);

        cancellationToken.ThrowIfCancellationRequested();
        return signature;
      }
      finally
      {
        CryptographicOperations.ZeroMemory(pinBuffer);
      }
    }
    finally
    {
      _slot.Release();
    }
  }

  // Devices missing a name, device ID, or certificate ID are skipped; they
  // cannot be addressed by card.verify or card.sign.
  private static IReadOnlyList<CardDevice> ListCore()
  {
    Throw(CardNative.Enumerate(out var list), "could not enumerate cards");

    try
    {
      var devices = new List<CardDevice>();
      var size = Marshal.SizeOf<CardNative.DeviceInfo>();

      for (nuint index = 0; index < list.Count; index++)
      {
        var item = Marshal.PtrToStructure<CardNative.DeviceInfo>(
          IntPtr.Add(list.Items, checked((int)(index * (nuint)size))));

        var name = Text(item.Name);
        var deviceId = Text(item.Identity.DeviceId);
        var certificateId = Text(item.Identity.CertificateId);

        if (name.Length == 0 || deviceId.Length == 0 || certificateId.Length == 0)
        {
          continue;
        }

        devices.Add(new CardDevice(name, deviceId, certificateId));
      }

      return devices;
    }
    finally
    {
      CardNative.FreeDeviceList(ref list);
    }
  }

  // Identity is checked before the PIN, so a mismatched device never consumes a
  // verification attempt.
  private static unsafe void VerifyCore(string device, string deviceId, byte[] pin)
  {
    var handle = OpenDevice(device);
    try
    {
      CheckIdentity(handle, deviceId);
      fixed (byte* pointer = pin)
      {
        Throw(
          CardNative.VerifyPin(handle, (IntPtr)pointer),
          "PIN verification failed");
      }
    }
    finally
    {
      CardNative.Close(handle);
    }
  }

  // The PIN is verified for this signature, then the message is streamed into the
  // engine. Any failure aborts the active signature before the device is closed.
  private static unsafe CardSignature SignCore(
    string device,
    string deviceId,
    byte[] pin,
    string messagePath,
    CancellationToken cancellationToken)
  {
    var handle = OpenDevice(device);
    try
    {
      CheckIdentity(handle, deviceId);

      fixed (byte* pointer = pin)
      {
        Throw(
          CardNative.VerifyPin(handle, (IntPtr)pointer),
          "PIN verification failed");
      }

      var signing = false;
      try
      {
        Throw(CardNative.SignStart(handle), "could not start signing");
        signing = true;

        using (var stream = new FileStream(
          messagePath,
          FileMode.Open,
          FileAccess.Read,
          FileShare.Read,
          ChunkSize,
          FileOptions.SequentialScan))
        {
          var buffer = new byte[ChunkSize];
          int read;

          while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
          {
            cancellationToken.ThrowIfCancellationRequested();
            fixed (byte* pointer = buffer)
            {
              Throw(
                CardNative.SignUpdate(handle, (IntPtr)pointer, (nuint)read),
                "could not hash the message");
            }
          }
        }

        var end = CardNative.SignFinish(handle, out var signature);
        signing = false;
        Throw(end, "could not sign the message");

        if (signature.Length > CardNative.MaxSignatureBytes)
        {
          throw new ProtocolException(
            ErrorCodes.CardFailed,
            "the card returned an oversized signature");
        }

        var length = (int)signature.Length;
        var algorithm = signature.Algorithm switch
        {
          CardNative.SignatureSm2 when length == 64 => "sm2",
          CardNative.SignatureRsaSha1 when length == 128 => "rsa-sha1",
          _ => throw new ProtocolException(
            ErrorCodes.CardFailed,
            "the card returned an unexpected signature"),
        };

        var bytes = new byte[length];
        Marshal.Copy((IntPtr)signature.Bytes, bytes, 0, length);
        return new CardSignature(algorithm, bytes);
      }
      finally
      {
        if (signing)
        {
          CardNative.SignAbort(handle);
        }
      }
    }
    finally
    {
      CardNative.Close(handle);
    }
  }

  private static IntPtr OpenDevice(string name)
  {
    Throw(CardNative.Open(name, out var handle), "could not open the device");
    return handle;
  }

  private static void CheckIdentity(IntPtr handle, string expectedDeviceId)
  {
    Throw(
      CardNative.ReadIdentity(handle, out var identity),
      "could not read the card identity");

    try
    {
      if (!DeviceIdMatches(identity.DeviceId, expectedDeviceId))
      {
        throw new ProtocolException(
          ErrorCodes.CardMismatch,
          "the card does not match the device ID");
      }
    }
    finally
    {
      CardNative.FreeIdentity(ref identity);
    }
  }

  // The engine exposes the ID as UTF-8 bytes; compare them byte for byte, with
  // no normalization.
  private static unsafe bool DeviceIdMatches(IntPtr actual, string expected)
  {
    if (actual == IntPtr.Zero)
    {
      return false;
    }

    var expectedBytes = Encoding.UTF8.GetBytes(expected);
    var length = 0;
    while (Marshal.ReadByte(actual, length) != 0)
    {
      length++;
    }

    if (length != expectedBytes.Length)
    {
      return false;
    }

    return new ReadOnlySpan<byte>((void*)actual, length).SequenceEqual(expectedBytes);
  }

  // A PIN is exactly eight non-NUL UTF-8 bytes. The engine receives it as a
  // NUL-terminated buffer.
  public static string ValidatePin(string pin)
  {
    if (pin.Contains('\0') || Encoding.UTF8.GetByteCount(pin) != Limits.CardPinBytes)
    {
      throw new ProtocolException(
        ErrorCodes.RequestInvalid,
        $"PIN must be exactly {Limits.CardPinBytes} UTF-8 bytes");
    }

    return pin;
  }

  private static byte[] EncodePin(string pin)
  {
    ValidatePin(pin);

    // The NUL-terminated buffer is the only copy of the PIN; the caller zeroes it
    // after the native call.
    var buffer = new byte[Limits.CardPinBytes + 1];
    Encoding.UTF8.GetBytes(pin.AsSpan(), buffer.AsSpan(0, Limits.CardPinBytes));
    return buffer;
  }

  private static void Throw(int result, string fallback)
  {
    if (result == CardNative.Ok)
    {
      return;
    }

    var message = CardNative.Describe(result);
    if (message.Length == 0)
    {
      message = fallback;
    }

    var code = result switch
    {
      CardNative.DeviceUnavailable => ErrorCodes.CardNotFound,
      CardNative.PinRejected => ErrorCodes.CardPinRejected,
      CardNative.VerificationRequired => ErrorCodes.CardPinRequired,
      CardNative.UnusableArgument => ErrorCodes.RequestInvalid,
      _ => ErrorCodes.CardFailed,
    };

    throw new ProtocolException(code, message);
  }

  private static string Text(IntPtr value) =>
    value == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUTF8(value) ?? string.Empty;
}
