import fs from 'fs';

export interface TokenLogEntry {
  timestamp: string;
  sessionId: string;
  groupFolder: string;
  inputTokens: number;
  outputTokens: number;
}

const TOKEN_LOG_PATH = '/workspace/group/token-log.jsonl';

export function appendTokenLog(entry: TokenLogEntry): void {
  try {
    fs.appendFileSync(TOKEN_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(
      `[agent-runner] Failed to write token log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
