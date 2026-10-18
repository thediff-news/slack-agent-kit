export interface Chunk {
  source: string;
  index: number;
  text: string;
}

/** Split a document into overlapping chunks on paragraph boundaries. */
export function chunkDocument(source: string, text: string, maxChars = 1200, overlap = 200): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let buf = "";
  let index = 0;
  const flush = () => {
    if (buf.trim().length > 0) chunks.push({ source, index: index++, text: buf.trim() });
  };
  for (const para of paragraphs) {
    if (buf.length + para.length + 2 > maxChars && buf.length > 0) {
      flush();
      buf = buf.slice(-overlap); // carry tail for context continuity
    }
    buf += (buf ? "\n\n" : "") + para;
  }
  flush();
  return chunks;
}
