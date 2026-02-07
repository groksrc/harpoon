/**
 * Split a document into sentence chunks.
 */
export function execute(document: string): { chunks: string[] } {
  // Simple sentence splitting (split on periods followed by space)
  const sentences = document.split(". ").map((s) => s.trim()).filter(Boolean);
  // Clean up trailing periods
  const chunks = sentences.map((s) => s.replace(/\.$/, ""));
  return { chunks };
}
