/**
 * Analyze a text chunk - count words and characters.
 */
export function execute(item: string, index: number = 0): Record<string, unknown> {
  const words = item.split(/\s+/).filter(Boolean);
  return {
    chunk: item,
    word_count: words.length,
    char_count: item.length,
  };
}
