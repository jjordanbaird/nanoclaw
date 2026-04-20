import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import { appendTokenLog } from './token-log.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    default: {
      ...actual,
      appendFileSync: vi.fn(),
    },
  };
});

const SAMPLE_ENTRY = {
  timestamp: '2026-04-20T22:00:00.000Z',
  sessionId: 'test-session-id',
  groupFolder: 'telegram_main',
  inputTokens: 1234,
  outputTokens: 567,
};

describe('appendTokenLog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('appends a JSONL entry to token-log.jsonl', () => {
    appendTokenLog(SAMPLE_ENTRY);

    expect(fs.appendFileSync).toHaveBeenCalledOnce();
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/workspace/group/token-log.jsonl',
      JSON.stringify(SAMPLE_ENTRY) + '\n',
    );
  });

  it('produces valid JSON that round-trips cleanly', () => {
    appendTokenLog(SAMPLE_ENTRY);

    const [, written] = vi.mocked(fs.appendFileSync).mock.calls[0] as [
      string,
      string,
    ];
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual(SAMPLE_ENTRY);
  });

  it('does not throw when fs.appendFileSync fails', () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(() => appendTokenLog(SAMPLE_ENTRY)).not.toThrow();
  });

  it('logs an error message when fs.appendFileSync fails', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    appendTokenLog(SAMPLE_ENTRY);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write token log'),
    );
    consoleSpy.mockRestore();
  });
});
