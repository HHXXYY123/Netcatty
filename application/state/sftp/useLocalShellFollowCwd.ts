import { useEffect, useRef } from "react";

interface LocalShellFollowCwdOptions {
  activeTerminalCwd: string | null;
  connectionId: string | null;
  connectionPath: string | null;
  connectionIsLocal: boolean | undefined;
  isVisible: boolean;
  hasActiveWork: boolean;
  followEnabled: boolean;
  onNavigate: (path: string) => Promise<void>;
}

/**
 * Local shell follow terminal cwd logic.
 * This is separate from the remote SSH follow logic to avoid complexity.
 */
export function useLocalShellFollowCwd({
  activeTerminalCwd,
  connectionId,
  connectionPath,
  connectionIsLocal,
  isVisible,
  hasActiveWork,
  followEnabled,
  onNavigate,
}: LocalShellFollowCwdOptions): void {
  const lastSyncedCwdRef = useRef<{ connectionId: string; cwd: string } | null>(null);
  const isNavigatingRef = useRef(false);

  useEffect(() => {
    if (!followEnabled || !connectionIsLocal || !isVisible || hasActiveWork) {
      return;
    }

    if (!connectionId || !activeTerminalCwd) {
      return;
    }

    // Already synced to this cwd
    if (
      lastSyncedCwdRef.current?.connectionId === connectionId &&
      lastSyncedCwdRef.current?.cwd === activeTerminalCwd
    ) {
      return;
    }

    // Already at this path
    if (connectionPath === activeTerminalCwd) {
      lastSyncedCwdRef.current = { connectionId, cwd: activeTerminalCwd };
      return;
    }

    // Navigation in progress
    if (isNavigatingRef.current) {
      return;
    }

    // Navigate to the new cwd
    isNavigatingRef.current = true;
    void onNavigate(activeTerminalCwd)
      .then(() => {
        lastSyncedCwdRef.current = { connectionId, cwd: activeTerminalCwd };
      })
      .catch((error) => {
        console.error("Local shell follow cwd navigation failed:", error);
      })
      .finally(() => {
        isNavigatingRef.current = false;
      });
  }, [
    followEnabled,
    connectionIsLocal,
    isVisible,
    hasActiveWork,
    connectionId,
    activeTerminalCwd,
    connectionPath,
    onNavigate,
  ]);

  // Reset sync state when connection changes
  useEffect(() => {
    lastSyncedCwdRef.current = null;
  }, [connectionId]);
}
