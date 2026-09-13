import type { TerminalSession } from '../types/terminal';
import type { ShellType } from '../domain/shellInterpretation';

type LocateSftpPathInTerminalContext = Pick<
  TerminalSession,
  'connectionId' | 'status' | 'protocol' | 'shellType'
> & {
  sessionId?: string;
  path: string;
  canUseTerminalCwd: boolean;
  trusted: boolean;
};

/**
 * Prefer the SFTP-reusable SSH session id when present; otherwise use the
 * focused terminal (mosh/et/local) so locate is not stuck behind connection reuse.
 */
export function resolveLocateSftpPathSessionId(options: {
  activeSessionId?: string | null;
  focusedSessionId?: string | null;
}): string | null {
  return options.activeSessionId ?? options.focusedSessionId ?? null;
}

export function canLocateSftpPathInTerminal(
  options: Pick<
    LocateSftpPathInTerminalContext,
    'canUseTerminalCwd' | 'trusted'
  >,
): boolean {
  return options.canUseTerminalCwd && options.trusted;
}

export type InteractiveTerminalCdIntent = {
  command: string;
};

/**
 * Given a remote SFTP path and the shell type, return a `cd` command
 * suitable for pasting into an interactive terminal. This function is used
 * when clicking "locate in terminal" or when enabling follow-terminal-cwd.
 */
export function resolveInteractiveTerminalCdIntent(
  path: string,
  shellType?: ShellType,
): InteractiveTerminalCdIntent | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  // Determine shell type: PowerShell, CMD, or POSIX (bash/zsh/fish)
  if (shellType === 'powershell') {
    // PowerShell: single quotes, escape single quotes as ''
    const quoted = `'${trimmed.replace(/'/g, "''")}'`;
    return { command: `Set-Location -LiteralPath ${quoted}` };
  }

  if (shellType === 'cmd') {
    // CMD: double quotes, escape double quotes as ""
    const quoted = `"${trimmed.replace(/"/g, '""')}"`;
    return { command: `cd /d ${quoted}` };
  }

  // POSIX shells (bash/zsh/fish): single quotes, escape single quotes as '\''
  const quoted = `'${trimmed.replace(/'/g, "'\\''")}'`;
  return { command: `cd -- ${quoted}` };
}

/**
 * Resolve an SFTP "locate in terminal" action into a sessionId + data payload
 * suitable for injection via the terminal's PTY.
 */
export function resolveLocateSftpPathInTerminal(
  options: LocateSftpPathInTerminalContext,
): { sessionId: string; data: string } | null {
  if (!canLocateSftpPathInTerminal(options) || !options.sessionId) return null;
  const intent = resolveInteractiveTerminalCdIntent(options.path, options.shellType ?? undefined);
  if (!intent) return null;
  return { sessionId: options.sessionId, data: `${intent.command}
` };
}

/** Session write payload for locating the SFTP path in the linked terminal (legacy alias). */
export function resolveLocateSftpPathInTerminalAction(
  options: LocateSftpPathInTerminalContext,
): { sessionId: string; data: string } | null {
  return resolveLocateSftpPathInTerminal(options);
}
