export function splitDocument(text: string, count: number): string[] {
  text = text.trim();
  if (!Number.isInteger(count) || count < 1 || count > 100 || !text) {
    throw new Error('Enter a document and a chunk count from 1 to 100.');
  }
  const paragraphs = new Set(Array.from(text.matchAll(/\n[\t \r]*\n\s*(?=\S)/g), match => match.index! + match[0].length));
  const sentences = new Set(Array.from(text.matchAll(/[.!?]["')\]]*\s+(?=\S)/g), match => match.index! + match[0].length));
  const words = Array.from(text.matchAll(/\s+(?=\S)/g), match => match.index! + match[0].length);
  const boundaries = [0, ...words, text.length];
  if (boundaries.length <= count) throw new Error('Use fewer chunks or add more words.');
  const preferred = words.filter(position => paragraphs.has(position));
  const fallback = words.filter(position => paragraphs.has(position) || sentences.has(position));
  const cuts = preferred.length >= count - 1 ? preferred : fallback.length >= count - 1 ? fallback : words;
  const chunks: string[] = [];
  let start = 0;
  let first = 0;
  for (let remaining = count; remaining > 1; remaining--) {
    const target = start + (text.length - start) / remaining;
    const last = cuts.length - remaining + 1;
    let best = first;
    while (best < last && Math.abs(cuts[best + 1] - target) < Math.abs(cuts[best] - target)) best++;
    chunks.push(text.slice(start, cuts[best]));
    start = cuts[best];
    first = best + 1;
  }
  return [...chunks, text.slice(start)];
}
