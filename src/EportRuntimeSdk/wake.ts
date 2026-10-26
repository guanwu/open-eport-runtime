// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

const WakeUrl = "eport-runtime://wake";
const FrameLifetimeMs = 2000;

// Launches the registered eport-runtime:// handler from a hidden iframe, leaving
// the page where it is. Browsers require user activation, so the caller must run
// this from the gesture that also attempted the connection. Returns false
// outside a document, where there is no handler to launch.
export function wake(): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = WakeUrl;
  (document.body ?? document.documentElement).append(frame);
  window.setTimeout(() => frame.remove(), FrameLifetimeMs);
  return true;
}
