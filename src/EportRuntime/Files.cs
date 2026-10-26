// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Security.Cryptography;

namespace EportRuntime;

public enum FsEntryType
{
  File,
  Dir,
  Link,
  Other,
}

public sealed record FsEntry(string Name, string Path, FsEntryType Type, long? Size, long MtimeMs);

public sealed record FsStat(FsEntryType Type, long Size, long MtimeMs);

// File operations over already-resolved absolute paths. stat and read follow a
// link to its final target; list and delete treat a link as an entry in its own
// right and never touch its target.
public static class FileSystem
{
  private const int BufferSize = 64 * 1024;

  public static FileStream CreateFile(string path) => new(
    path,
    FileMode.CreateNew,
    FileAccess.Write,
    FileShare.None,
    BufferSize,
    FileOptions.Asynchronous | FileOptions.SequentialScan);

  public static FileStream OpenRead(string path) => new(
    path,
    FileMode.Open,
    FileAccess.Read,
    FileShare.Read,
    BufferSize,
    FileOptions.Asynchronous | FileOptions.SequentialScan);

  // The part file sits in the target directory, which keeps the commit rename on
  // one volume. Random names plus CreateNew make collisions harmless.
  public static FileStream CreatePartFile(string targetPath, out string partPath)
  {
    var directory = Path.GetDirectoryName(targetPath);
    if (string.IsNullOrEmpty(directory))
    {
      throw new EportException($"{targetPath}: target directory is missing");
    }

    for (var attempt = 0; attempt < 5; attempt++)
    {
      var candidate = Path.Combine(
        directory,
        ".eport-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant() + ".part");

      try
      {
        var stream = new FileStream(
          candidate,
          FileMode.CreateNew,
          FileAccess.Write,
          FileShare.None,
          BufferSize,
          FileOptions.Asynchronous | FileOptions.SequentialScan);

        partPath = candidate;
        return stream;
      }
      catch (IOException) when (File.Exists(candidate))
      {
      }
    }

    partPath = string.Empty;
    throw new EportException($"{targetPath}: could not create a temporary file");
  }

  // A directory link cannot be replaced by a file rename, so it is removed first.
  // The link target is never opened or modified.
  public static void Commit(string partPath, string targetPath)
  {
    try
    {
      var attributes = File.GetAttributes(targetPath);
      if ((attributes & FileAttributes.ReparsePoint) != 0 &&
          (attributes & FileAttributes.Directory) != 0)
      {
        Directory.Delete(targetPath, recursive: false);
      }
    }
    catch (FileNotFoundException)
    {
    }
    catch (DirectoryNotFoundException)
    {
    }

    File.Move(partPath, targetPath, overwrite: true);
  }

  public static void TryDeleteFile(string path)
  {
    try
    {
      File.Delete(path);
    }
    catch (Exception)
    {
    }
  }

  // Reports the final target of a link, including its type and size; a dangling
  // link is reported as not found.
  public static FsStat Stat(string path)
  {
    if (!File.Exists(path) && !Directory.Exists(path))
    {
      throw new FileNotFoundException($"{path}: not found", path);
    }

    var attributes = File.GetAttributes(path);
    if ((attributes & FileAttributes.ReparsePoint) != 0)
    {
      var target = ResolveLinkTarget(path, attributes);
      if (target is not null)
      {
        path = target;
        if (!File.Exists(path) && !Directory.Exists(path))
        {
          throw new FileNotFoundException($"{path}: not found", path);
        }

        attributes = File.GetAttributes(path);
      }
    }

    var mtime = new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero).ToUnixTimeMilliseconds();

    var (type, size) = Classify(path, attributes);
    return new FsStat(type, size, mtime);
  }

  private static string? ResolveLinkTarget(string path, FileAttributes attributes)
  {
    try
    {
      var target = (attributes & FileAttributes.Directory) != 0
        ? Directory.ResolveLinkTarget(path, returnFinalTarget: true)
        : File.ResolveLinkTarget(path, returnFinalTarget: true);
      return target?.FullName;
    }
    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
    {
      return null;
    }
  }

  // Uses an explicit stack. Links are described but never entered, so a cycle
  // cannot trap the walk.
  public static IEnumerable<FsEntry> List(string path, bool recursive)
  {
    var root = Path.GetFullPath(path);
    if (!Directory.Exists(root))
    {
      throw new DirectoryNotFoundException($"{path}: not found");
    }

    var pending = new Stack<string>();
    pending.Push(root);

    while (pending.Count > 0)
    {
      var directory = pending.Pop();
      foreach (var child in Directory.EnumerateFileSystemEntries(directory))
      {
        var entry = Describe(child);
        yield return entry;

        if (recursive && entry.Type == FsEntryType.Dir)
        {
          pending.Push(child);
        }
      }
    }
  }

  // Deletes a link itself, never its target. Recursive deletion descends real
  // directories and removes the links it finds without following them.
  public static void Delete(string path, bool recursive)
  {
    var attributes = File.GetAttributes(path);
    var isLink = (attributes & FileAttributes.ReparsePoint) != 0;

    if (isLink)
    {
      DeleteLink(path, attributes);
      return;
    }

    if ((attributes & FileAttributes.Directory) == 0)
    {
      File.Delete(path);
      return;
    }

    if (!recursive)
    {
      Directory.Delete(path, recursive: false);
      return;
    }

    foreach (var child in Directory.EnumerateFileSystemEntries(path))
    {
      DeleteRecursive(child);
    }

    Directory.Delete(path, recursive: false);
  }

  private static void DeleteRecursive(string path)
  {
    var attributes = File.GetAttributes(path);
    if ((attributes & FileAttributes.ReparsePoint) != 0)
    {
      DeleteLink(path, attributes);
      return;
    }

    if ((attributes & FileAttributes.Directory) != 0)
    {
      foreach (var child in Directory.EnumerateFileSystemEntries(path))
      {
        DeleteRecursive(child);
      }

      Directory.Delete(path, recursive: false);
      return;
    }

    File.Delete(path);
  }

  private static void DeleteLink(string path, FileAttributes attributes)
  {
    if ((attributes & FileAttributes.Directory) != 0)
    {
      Directory.Delete(path, recursive: false);
    }
    else
    {
      File.Delete(path);
    }
  }

  private static FsEntry Describe(string path)
  {
    var attributes = File.GetAttributes(path);
    var name = Path.GetFileName(path);
    var mtime = new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero).ToUnixTimeMilliseconds();

    var link = (attributes & FileAttributes.ReparsePoint) != 0;
    var (type, size) = Classify(path, attributes, link);
    return new FsEntry(name, path, type, link ? null : size, mtime);
  }

  // An unreadable size becomes zero; the type is still reported.
  private static (FsEntryType Type, long Size) Classify(
    string path,
    FileAttributes attributes,
    bool link = false)
  {
    if (link)
    {
      return (FsEntryType.Link, 0);
    }

    if ((attributes & FileAttributes.Directory) != 0)
    {
      return (FsEntryType.Dir, 0);
    }

    if ((attributes & FileAttributes.Device) != 0)
    {
      return (FsEntryType.Other, 0);
    }

    try
    {
      return (FsEntryType.File, new FileInfo(path).Length);
    }
    catch (IOException)
    {
      return (FsEntryType.File, 0);
    }
  }
}

// Relative paths resolve against AgentHome. A bare executable name is looked up
// in AgentHome first and then in PATH; Windows also tries .exe and .com.
public sealed class PathResolver
{
  public string AgentHome { get; }

  public PathResolver(string agentHome)
  {
    AgentHome = agentHome;
  }

  public string Resolve(string path)
  {
    try
    {
      return Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(AgentHome, path));
    }
    catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
    {
      throw new ProtocolException(ErrorCodes.RequestInvalid, $"{path}: {ex.Message}");
    }
  }

  public string ResolveWorkingDirectory(string? path) =>
    string.IsNullOrEmpty(path) ? AgentHome : Resolve(path);

  public string ResolveExecutable(string file)
  {
    if (string.IsNullOrEmpty(file))
    {
      throw new ProtocolException(ErrorCodes.RequestInvalid, "executable name is empty");
    }

    if (file.Contains(Path.DirectorySeparatorChar) || file.Contains(Path.AltDirectorySeparatorChar))
    {
      var explicitPath = Resolve(file);
      if (File.Exists(explicitPath))
      {
        return explicitPath;
      }

      throw new EportException($"{file}: executable not found");
    }

    foreach (var directory in SearchDirectories())
    {
      foreach (var candidate in CandidateNames(file))
      {
        var path = Path.Combine(directory, candidate);
        if (File.Exists(path))
        {
          return path;
        }
      }
    }

    throw new EportException($"{file}: executable not found");
  }

  private IEnumerable<string> SearchDirectories()
  {
    yield return AgentHome;

    var path = Environment.GetEnvironmentVariable("PATH");
    if (string.IsNullOrEmpty(path))
    {
      yield break;
    }

    foreach (var directory in path.Split(Path.PathSeparator))
    {
      if (!string.IsNullOrWhiteSpace(directory))
      {
        yield return directory;
      }
    }
  }

  private static IEnumerable<string> CandidateNames(string file)
  {
    yield return file;

    if (!OperatingSystem.IsWindows() || file.Contains('.'))
    {
      yield break;
    }

    yield return file + ".exe";
    yield return file + ".com";
  }
}
