/**
 * Calculates Shannon entropy (bits per symbol) of a given string.
 * High entropy (> 4.8 for typical alphanumeric strings of length >= 32)
 * frequently signals encrypted payloads, binary shellcode, or obfuscated payloads.
 */
export function calculateShannonEntropy(input: string): number {
  if (!input || input.length === 0) {
    return 0.0;
  }

  const frequencies = new Map<string, number>();
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }

  const len = input.length;
  let entropy = 0.0;

  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Scans tokens or long substrings in a text and returns true if any token
 * exhibits suspiciously high entropy exceeding the threshold.
 */
export function detectHighEntropyTokens(
  text: string,
  minTokenLength = 32,
  threshold = 4.8
): { found: boolean; tokens: string[] } {
  if (!text) {
    return { found: false, tokens: [] };
  }

  const tokens = text.split(/\s+/);
  const suspicious: string[] = [];

  for (const token of tokens) {
    if (token.length >= minTokenLength) {
      const ent = calculateShannonEntropy(token);
      if (ent >= threshold) {
        suspicious.push(token);
      }
    }
  }

  return {
    found: suspicious.length > 0,
    tokens: suspicious,
  };
}
