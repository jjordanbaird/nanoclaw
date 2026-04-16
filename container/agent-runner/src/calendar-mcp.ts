/**
 * Calendar MCP Server for NanoClaw
 * Fetches and parses iCal/ICS data from a public URL.
 * URL is read from /workspace/group/.calendar-url at request time.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';

const CALENDAR_URL_FILE = '/workspace/group/.calendar-url';

function getCalendarUrl(): string | null {
  try {
    if (fs.existsSync(CALENDAR_URL_FILE)) {
      const raw = fs.readFileSync(CALENDAR_URL_FILE, 'utf-8').trim();
      if (!raw) return null;
      // webcal:// is served over HTTPS
      return raw.replace(/^webcal:\/\//i, 'https://');
    }
  } catch { /* ignore */ }
  return null;
}

async function fetchCalendar(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.text();
}

interface CalendarEvent {
  uid: string;
  summary: string;
  start: Date | null;
  end: Date | null;
  isAllDay: boolean;
  description?: string;
  location?: string;
}

// RFC 5545 line unfolding: CRLF + whitespace = continuation
function unfoldLines(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, '');
}

function parseIcsDate(value: string): { date: Date; allDay: boolean } {
  // All-day: YYYYMMDD
  if (/^\d{8}$/.test(value)) {
    const y = parseInt(value.slice(0, 4));
    const m = parseInt(value.slice(4, 6)) - 1;
    const d = parseInt(value.slice(6, 8));
    return { date: new Date(y, m, d), allDay: true };
  }
  // Datetime: YYYYMMDDTHHmmss[Z]
  const dm = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (dm) {
    const iso = `${dm[1]}-${dm[2]}-${dm[3]}T${dm[4]}:${dm[5]}:${dm[6]}${dm[7] === 'Z' ? 'Z' : ''}`;
    return { date: new Date(iso), allDay: false };
  }
  return { date: new Date(value), allDay: false };
}

function parseIcsEvents(ics: string): CalendarEvent[] {
  const unfolded = unfoldLines(ics);
  const events: CalendarEvent[] = [];

  const getField = (block: string, name: string): string | undefined => {
    const match = block.match(new RegExp(`(?:^|\\n)${name}(?:;[^:\\n]*)?:([^\\n]*)`, 'i'));
    return match ? match[1].trim() : undefined;
  };

  const unescape = (s: string) =>
    s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

  const blocks = unfolded.split(/BEGIN:VEVENT/i);
  for (const block of blocks.slice(1)) {
    const endIdx = block.search(/END:VEVENT/i);
    const content = endIdx !== -1 ? block.slice(0, endIdx) : block;

    const summaryRaw = getField(content, 'SUMMARY') || '(No title)';
    const summary = unescape(summaryRaw);
    const uid = getField(content, 'UID') || '';

    const description = getField(content, 'DESCRIPTION');
    const location = getField(content, 'LOCATION');

    const dtStartRaw = content.match(/(?:^|\n)DTSTART(?:;[^:\n]*)?:([^\n]*)/i)?.[1]?.trim();
    const dtEndRaw = content.match(/(?:^|\n)DTEND(?:;[^:\n]*)?:([^\n]*)/i)?.[1]?.trim();

    if (!dtStartRaw) continue;

    const { date: start, allDay: isAllDay } = parseIcsDate(dtStartRaw);
    const end = dtEndRaw ? parseIcsDate(dtEndRaw).date : null;

    events.push({
      uid,
      summary,
      start,
      end,
      isAllDay,
      description: description ? unescape(description) : undefined,
      location: location ? unescape(location) : undefined,
    });
  }

  return events;
}

function formatEvent(event: CalendarEvent): string {
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    ...dateOpts,
    hour: 'numeric',
    minute: '2-digit',
  };

  const startStr = event.isAllDay
    ? event.start!.toLocaleDateString('en-US', dateOpts)
    : event.start!.toLocaleString('en-US', timeOpts);

  const endStr = event.end
    ? event.isAllDay
      ? event.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : event.end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null;

  let line = `• ${event.summary}`;
  line += `\n  When: ${startStr}${endStr ? ` – ${endStr}` : ''}`;
  if (event.location) line += `\n  Where: ${event.location}`;
  if (event.description) {
    const desc = event.description.slice(0, 300);
    line += `\n  Notes: ${desc}${event.description.length > 300 ? '…' : ''}`;
  }
  return line;
}

const server = new McpServer({ name: 'calendar', version: '1.0.0' });

server.tool(
  'get_calendar_events',
  'Fetch calendar events within a date range. Defaults to the next 7 days.',
  {
    days_back: z.number().int().min(0).max(365).default(0)
      .describe('Days in the past to include (default: 0)'),
    days_ahead: z.number().int().min(1).max(365).default(7)
      .describe('Days ahead to include (default: 7)'),
  },
  async (args) => {
    const url = getCalendarUrl();
    if (!url) {
      return {
        content: [{ type: 'text' as const, text: 'No calendar URL configured.' }],
        isError: true,
      };
    }

    try {
      const ics = await fetchCalendar(url);
      const all = parseIcsEvents(ics);

      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - args.days_back);
      from.setHours(0, 0, 0, 0);
      const to = new Date(now);
      to.setDate(to.getDate() + args.days_ahead);
      to.setHours(23, 59, 59, 999);

      const filtered = all
        .filter(e => e.start && e.start >= from && e.start <= to)
        .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));

      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: `No events in the next ${args.days_ahead} days.` }] };
      }

      const text = `${filtered.length} event(s):\n\n${filtered.map(formatEvent).join('\n\n')}`;
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_upcoming_events',
  'Get the next N upcoming events from the calendar.',
  {
    count: z.number().int().min(1).max(50).default(5)
      .describe('Number of upcoming events to return (default: 5)'),
  },
  async (args) => {
    const url = getCalendarUrl();
    if (!url) {
      return {
        content: [{ type: 'text' as const, text: 'No calendar URL configured.' }],
        isError: true,
      };
    }

    try {
      const ics = await fetchCalendar(url);
      const all = parseIcsEvents(ics);
      const now = new Date();

      const upcoming = all
        .filter(e => e.start && e.start >= now)
        .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0))
        .slice(0, args.count);

      if (upcoming.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No upcoming events found.' }] };
      }

      const text = `Next ${upcoming.length} event(s):\n\n${upcoming.map(formatEvent).join('\n\n')}`;
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
