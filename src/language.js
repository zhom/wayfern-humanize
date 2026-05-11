// @ts-check

const COMMON_WORDS = new Set([
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "it",
    "for", "not", "on", "with", "he", "as", "you", "do", "at", "this",
    "but", "his", "by", "from", "they", "we", "say", "her", "she", "or",
    "an", "will", "my", "one", "all", "would", "there", "their", "what",
    "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
    "when", "make", "can", "like", "time", "no", "just", "him", "know",
    "take", "people", "into", "year", "your", "good", "some", "could",
    "them", "see", "other", "than", "then", "now", "look", "only", "come",
    "its", "over", "think", "also", "back", "after", "use", "two", "how",
    "our", "work", "first", "well", "way", "even", "new", "want", "because",
]);

const COMMON_BIGRAMS = new Set([
    "th", "he", "in", "er", "an", "re", "on", "at", "en", "nd", "ti", "es",
    "or", "te", "of", "ed", "is", "it", "al", "ar", "st", "to", "nt", "ng",
    "se", "ha", "as", "ou", "io", "le", "ve", "co", "me", "de", "hi", "ri",
    "ro", "ic", "ne", "ea", "ra", "ce",
]);

const PUNCT_RE = /^[.,!?;:'"\-()[\]{}/]+|[.,!?;:'"\-()[\]{}/]+$/g;

/**
 * @param {string} word
 * @returns {"common" | "complex" | "normal"}
 */
export function getWordDifficulty(word) {
    const trimmed = word.toLowerCase().replace(PUNCT_RE, "");
    if (COMMON_WORDS.has(trimmed)) return "common";
    const isLong = trimmed.length > 8;
    const hasComplex = /[zxqj]/.test(trimmed);
    if (isLong || hasComplex) return "complex";
    return "normal";
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isCommonBigram(a, b) {
    return COMMON_BIGRAMS.has((a + b).toLowerCase());
}
