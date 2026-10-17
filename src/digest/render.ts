/**
 * The digest as a document, and its renderings: Discord markdown (`plain`
 * layout, or one embed per section), and plain text for Slack, Telegram,
 * iMessage and the terminal.
 *
 * Headlines, why-lines, outlet names, URLs and the fallback's AI summary come
 * from feeds or from a model that read feeds, so they are untrusted. For
 * Discord each is escaped where it is inserted, so a title can't add links,
 * spoilers, emphasis or mentions, while the digest's own markup (bold
 * headers, masked links, subtext) stays intact. Nothing here escapes a whole
 * message.
 */

/** One story or item. Every field but `outlets` order is untrusted text. */
export interface DigestEntry {
  headline: string;
  url?: string;
  why?: string;
  outlets?: string[];
}

export interface DigestSection {
  title: string;
  icon: string;
  /** `stories`: numbered, with why-line and outlets. `story`: the same, unnumbered. `list`: one line each. */
  style: 'stories' | 'story' | 'list';
  entries: DigestEntry[];
  /** Shown instead of the entries when there are none. Sections without one are left out when empty. */
  empty?: string;
}

export interface DigestDocument {
  /** The day the digest is for, shown in the header. */
  date: Date;
  /** Untrusted: the fallback's optional AI summary, or our own one-liner on an empty day. */
  intro?: string;
  sections: DigestSection[];
  /** How the digest was ranked. Our own text. */
  footer: string;
}

export const REPO_URL = 'https://github.com/JoonJ14/ai-newsroom';

/** Discord's limits (discord.com/developers/docs/resources/message). */
export const DISCORD_LIMITS = {
  content: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  embedFooter: 2048,
  embedsPerMessage: 10,
  embedTotal: 6000,
};

/** Most outlets named on a story; the rest are counted. */
const MAX_OUTLETS = 5;

export function formatDigestDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  }).format(date);
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function outletList(outlets: string[], max = MAX_OUTLETS): string[] {
  return outlets.length > max ? [...outlets.slice(0, max), `+${outlets.length - max} more`] : outlets;
}

// ─── Discord ─────────────────────────────────────────────────────

/**
 * Untrusted text for a Discord message or embed: one line, its markup
 * characters backslash-escaped (Discord hides an escaping backslash, so the
 * text reads as written), and a word joiner after "@" so @everyone or @here
 * can't mention anyone even without allowed_mentions. Escaped:
 *   \ * _ ~ ` |     emphasis, code, spoilers, and the escapes themselves
 *   [ ]             masked links (without them, "(…)" is just text)
 *   < >             <@user>, <#channel>, <t:…>, <:emoji:>, <https://…>
 *   ://             autolinks: "https\://x" is shown, not linked
 * Headers, subtext, lists and quotes (#, -#, -, >) only work at the start of
 * a line, and a field never starts one: our own prefix always comes first.
 */
export function escapeDiscord(text: string): string {
  return oneLine(text)
    .replace(/[\\*_~`|[\]<>]/g, '\\$&')
    .replace(/:\/\//g, '\\://')
    .replace(/@/g, '@\u2060');
}

/**
 * A URL we can put in a masked link: http(s) only, with the characters that
 * would end the link (or its <…> wrapper) percent-encoded. Anything else is
 * not linked at all.
 */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return parsed.href.replace(/[()<> ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/**
 * `[label](<url>)`: a link Discord shows as its label. The angle brackets stop
 * Discord adding a preview card for it. `wrap: false` for embeds, which never
 * preview links.
 */
export function discordLink(label: string, url: string | undefined, wrap = true): string {
  const text = escapeDiscord(label);
  const href = safeUrl(url);
  if (!href) return text;
  return wrap ? `[${text}](<${href}>)` : `[${text}](${href})`;
}

const discordOutlets = (outlets: string[]) => outletList(outlets).map(escapeDiscord).join(' · ');

/**
 * One entry as Discord markdown. `compact` drops the link and shortens the
 * text, for the rare entry too long for a message on its own.
 */
function discordEntry(e: DigestEntry, style: DigestSection['style'], n: number, wrap: boolean, compact = false): string {
  const headline = compact ? escapeDiscord(truncate(e.headline, 200)) : discordLink(e.headline, e.url, wrap);
  if (style === 'list') {
    const by = e.outlets?.length ? ` · ${discordOutlets(e.outlets.slice(0, 1))}` : '';
    return `• ${headline}${by}`;
  }
  const lines = [style === 'stories' ? `**${n}. ${headline}**` : `**${headline}**`];
  if (e.why) lines.push(`   ${escapeDiscord(compact ? truncate(e.why, 300) : e.why)}`);
  if (e.outlets?.length) lines.push(`   *${discordOutlets(compact ? e.outlets.slice(0, 3) : e.outlets)}*`);
  return lines.join('\n');
}

/** The entries of a section, each one fitted to `max` characters. */
function discordEntries(section: DigestSection, wrap: boolean, max: number): string[] {
  return section.entries.map((e, i) => {
    const full = discordEntry(e, section.style, i + 1, wrap);
    return full.length <= max ? full : discordEntry(e, section.style, i + 1, wrap, true);
  });
}

const visible = (doc: DigestDocument) => doc.sections.filter((s) => s.entries.length > 0 || s.empty);

const discordHeader = (doc: DigestDocument) => `**🤖 AI Newsroom** · ${formatDigestDate(doc.date)}`;

export function discordFooter(doc: DigestDocument): string {
  return `-# ${doc.footer} · [github.com/JoonJ14/ai-newsroom](<${REPO_URL}>)`;
}

/**
 * Pack blocks into messages of at most `limit` characters, never splitting a
 * block. Each group (a section: its header and entries) starts a new message
 * if it doesn't fit in the current one but would fit in an empty one, so a
 * section is split only when it is longer than a whole message.
 */
export function packBlocks(groups: string[][], limit: number, sep = '\n\n'): string[] {
  const out: string[] = [];
  let current = '';
  const add = (block: string) => {
    if (current && current.length + sep.length + block.length > limit) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}${sep}${block}` : block;
  };
  for (const group of groups) {
    const whole = group.join(sep);
    if (current && current.length + sep.length + whole.length > limit && whole.length <= limit) {
      out.push(current);
      current = '';
    }
    group.forEach(add);
  }
  if (current) out.push(current);
  return out;
}

/** The `plain` layout: regular messages, normally one. */
export function renderDiscordPlain(doc: DigestDocument): string[] {
  const limit = DISCORD_LIMITS.content;
  const head = [discordHeader(doc)];
  if (doc.intro) head.push(escapeDiscord(doc.intro));
  const groups: string[][] = [[head.join('\n')]];
  for (const section of visible(doc)) {
    const title = `**${section.icon} ${section.title}**`;
    // A section header stays with its first entry
    const entries = section.entries.length > 0
      ? discordEntries(section, true, limit - title.length - 1)
      : [`*${section.empty}*`];
    const blocks = [`${title}\n${entries[0]}`, ...entries.slice(1)];
    // A list is one block, line by line, unless it's longer than a message
    const list = [title, ...entries].join('\n');
    groups.push(section.style === 'list' && list.length <= limit ? [list] : blocks);
  }
  groups.push([discordFooter(doc)]);
  return packBlocks(groups, limit);
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  footer?: { text: string };
}

export interface DiscordPayload {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: { parse: [] };
  /** 4 = SUPPRESS_EMBEDS: no preview cards for any link in a plain message. */
  flags?: number;
}

const SECTION_COLORS = [0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0x99aab5];

const embedSize = (e: DiscordEmbed) => e.title.length + e.description.length + (e.footer?.text.length ?? 0);

/**
 * The `embeds` layout: the header as the message text, then one embed per
 * section (a long section continues in a second embed), the ranking line in
 * the last embed's footer. Embeds go out ten at a time and at most 6,000
 * characters per message.
 */
export function renderDiscordEmbeds(doc: DigestDocument): DiscordPayload[] {
  const L = DISCORD_LIMITS;
  const embeds: DiscordEmbed[] = [];
  visible(doc).forEach((section, i) => {
    const title = truncate(`${section.icon} ${section.title}`, L.embedTitle);
    const color = SECTION_COLORS[i % SECTION_COLORS.length];
    const entries = section.entries.length > 0 ? discordEntries(section, false, L.embedDescription) : [`*${section.empty}*`];
    const sep = section.style === 'list' ? '\n' : '\n\n';
    packBlocks([entries], L.embedDescription, sep).forEach((description, part) => {
      embeds.push({ title: part === 0 ? title : `${title} (continued)`, description, color });
    });
  });
  const footer = { text: `${doc.footer} · github.com/JoonJ14/ai-newsroom` };
  if (embeds.length === 0) embeds.push({ title: '🤖 AI Newsroom', description: '*Nothing to report.*', color: SECTION_COLORS[0] });
  embeds[embeds.length - 1].footer = footer;

  const content = [discordHeader(doc), ...(doc.intro ? [escapeDiscord(doc.intro)] : [])].join('\n');
  const payloads: DiscordPayload[] = [];
  let batch: DiscordEmbed[] = [];
  let size = 0;
  for (const e of embeds) {
    if (batch.length === L.embedsPerMessage || (batch.length > 0 && size + embedSize(e) > L.embedTotal)) {
      payloads.push({ embeds: batch, allowed_mentions: { parse: [] } });
      batch = [];
      size = 0;
    }
    batch.push(e);
    size += embedSize(e);
  }
  payloads.push({ embeds: batch, allowed_mentions: { parse: [] } });
  payloads[0].content = truncate(content, L.content);
  return payloads;
}

/** Messages for the chosen layout, as webhook bodies. */
export function discordPayloads(doc: DigestDocument, layout: 'plain' | 'embeds'): DiscordPayload[] {
  if (layout === 'embeds') return renderDiscordEmbeds(doc);
  return renderDiscordPlain(doc).map((content) => ({ content, allowed_mentions: { parse: [] }, flags: 4 }));
}

// ─── Plain text ──────────────────────────────────────────────────

/**
 * For Slack, Telegram, iMessage and the terminal: no markup, each URL in full
 * on its own line. Entries are separated by blank lines, list items by line
 * breaks, so splitting at a blank line never splits a story. The adapters
 * keep their own escaping (Slack's &<>, Telegram's @).
 */
export function renderText(doc: DigestDocument): string {
  const blocks: string[] = [`🤖 AI Newsroom · ${formatDigestDate(doc.date)}`];
  if (doc.intro) blocks.push(oneLine(doc.intro));
  for (const section of visible(doc)) {
    const title = `${section.icon} ${section.title.toUpperCase()}`;
    const url = (e: DigestEntry) => safeUrl(e.url);
    if (section.entries.length === 0) {
      blocks.push(`${title}\n${section.empty}`);
    } else if (section.style === 'list') {
      const lines = section.entries.map((e) => {
        const by = e.outlets?.length ? ` (${oneLine(e.outlets[0])})` : '';
        return [`• ${oneLine(e.headline)}${by}`, ...(url(e) ? [`  ${url(e)}`] : [])].join('\n');
      });
      blocks.push(`${title}\n${lines.join('\n')}`);
    } else {
      const entries = section.entries.map((e, i) => {
        const lines = [section.style === 'stories' ? `${i + 1}. ${oneLine(e.headline)}` : oneLine(e.headline)];
        if (e.why) lines.push(`   ${oneLine(e.why)}`);
        if (e.outlets?.length) lines.push(`   ${outletList(e.outlets).map(oneLine).join(' · ')}`);
        if (url(e)) lines.push(`   ${url(e)}`);
        return lines.join('\n');
      });
      blocks.push(`${title}\n${entries[0]}`, ...entries.slice(1));
    }
  }
  blocks.push(`${doc.footer}\n${REPO_URL}`);
  return blocks.join('\n\n');
}

/**
 * Split plain text at blank lines into messages of at most `maxLen`. A block
 * longer than that (a long list) is split between its items: at a line that
 * isn't indented, so an item's URL stays with its headline.
 */
export function splitText(message: string, maxLen: number): string[] {
  const blocks = message
    .split('\n\n')
    .flatMap((b) => (b.length <= maxLen ? [b] : packBlocks([b.split(/\n(?=\S)/)], maxLen, '\n')));
  return packBlocks(blocks.map((b) => [b]), maxLen);
}
