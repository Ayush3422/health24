/**
 * Search folding for traditional-medicine terminology.
 *
 * A vaidya searching for Amlapitta may type अम्लपित्त, amlapitta, Amlapitta or
 * the scholarly amlapitta-with-diacritics. All four must reach the same concept.
 * Hindi-speaking users also write the way they speak — "jwar" for ज्वर, "deepak"
 * for दीपक — and drop the final inherent vowel Sanskrit keeps.
 *
 * `foldTerm` reduces all of these to one comparable ASCII key. It is lossy on
 * purpose: श and स, छ and च, ई and इ collapse together, because a search that
 * misses on a sibilant is a search a clinician stops trusting. Ranking, not
 * folding, is what separates close matches.
 *
 * Two rules follow from that:
 *
 *   1. The folded value is never displayed. A term is always shown as it was
 *      published.
 *   2. Index time and query time must use this exact function. That is why it
 *      lives in the shared package — if the database indexed one fold and the
 *      search box sent another, search would fail silently, returning nothing
 *      rather than an error.
 *
 * Devanagari and Latin only. Tamil script (Siddha) and Urdu script (Unani) are
 * not handled yet.
 */

const CONSONANTS: Readonly<Record<string, string>> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'n',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'n',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  ऩ: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ऱ: 'r',
  ल: 'l',
  ळ: 'l',
  ऴ: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
};

/** Consonants modified by a nukta, as used for Perso-Arabic sounds in Hindi. */
const NUKTA_CONSONANTS: Readonly<Record<string, string>> = {
  क: 'q',
  ख: 'kh',
  ग: 'gh',
  ज: 'z',
  ड: 'r',
  ढ: 'rh',
  फ: 'f',
};

const INDEPENDENT_VOWELS: Readonly<Record<string, string>> = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ii',
  उ: 'u',
  ऊ: 'uu',
  ऋ: 'ri',
  ॠ: 'ri',
  ऌ: 'li',
  ॡ: 'li',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
};

/** Dependent vowel signs, which replace a consonant's inherent vowel. */
const VOWEL_SIGNS: Readonly<Record<string, string>> = {
  'ा': 'aa',
  'ि': 'i',
  'ी': 'ii',
  'ु': 'u',
  'ू': 'uu',
  'ृ': 'ri',
  'ॄ': 'ri',
  'ॢ': 'li',
  'ॣ': 'li',
  'े': 'e',
  'ै': 'ai',
  'ो': 'o',
  'ौ': 'au',
};

const VIRAMA = '्';
const NUKTA = '़';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';
const AVAGRAHA = 'ऽ';
const OM = 'ॐ';

/**
 * Placeholder for an anusvara until the following letter is known. The nasal
 * it stands for depends on what comes next — म before प, ब and म, न elsewhere —
 * so it cannot be resolved one character at a time.
 */
const NASAL = '';

/** IAST letters whose base form after stripping marks would be wrong. */
const LATIN_SPECIAL: Readonly<Record<string, string>> = {
  ś: 'sh',
  ṣ: 'sh',
  ṛ: 'ri',
  ṝ: 'ri',
  ḷ: 'li',
  ḹ: 'li',
  ṃ: NASAL,
  ṁ: NASAL,
  ṅ: 'n',
  ñ: 'n',
  ṇ: 'n',
  ḥ: 'h',
};

function transliterateDevanagari(text: string): string {
  const chars = [...text];
  let out = '';

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    const consonant = CONSONANTS[ch];

    if (consonant !== undefined) {
      let roman = consonant;
      let next = chars[i + 1];

      if (next === NUKTA) {
        roman = NUKTA_CONSONANTS[ch] ?? consonant;
        i += 1;
        next = chars[i + 1];
      }

      if (next === VIRAMA) {
        // Half-consonant in a cluster: no vowel follows.
        out += roman;
        i += 1;
        continue;
      }

      const sign = next === undefined ? undefined : VOWEL_SIGNS[next];

      if (sign !== undefined) {
        out += roman + sign;
        i += 1;
        continue;
      }

      // The inherent vowel.
      out += `${roman}a`;
      continue;
    }

    const vowel = INDEPENDENT_VOWELS[ch];
    if (vowel !== undefined) {
      out += vowel;
      continue;
    }

    if (ch === ANUSVARA) {
      out += NASAL;
    } else if (ch === CHANDRABINDU) {
      out += 'n';
    } else if (ch === VISARGA) {
      out += 'h';
    } else if (ch === OM) {
      out += 'om';
    } else if (ch === '।' || ch === '॥') {
      out += ' '; // danda, double danda
    } else if (ch >= '०' && ch <= '९') {
      out += String(ch.charCodeAt(0) - 0x0966);
    } else if (ch === VIRAMA || ch === NUKTA || ch === AVAGRAHA || VOWEL_SIGNS[ch] !== undefined) {
      // A stray mark with no consonant to attach to. Dropped.
    } else {
      out += ch;
    }
  }

  return out;
}

/**
 * Drops a word-final inherent vowel, so that Sanskrit "jvara" and spoken Hindi
 * "jwar" meet. Short words are left alone: stripping "ama" to "am" costs more
 * precision than it earns recall.
 */
function dropFinalSchwa(token: string): string {
  if (token.length > 3 && token.endsWith('a') && !/[aeiou]/.test(token.charAt(token.length - 2))) {
    return token.slice(0, -1);
  }

  return token;
}

export function foldTerm(input: string): string {
  if (!input) {
    return '';
  }

  let value = input
    .normalize('NFC')
    .replace(/[‌‍]/g, '') // zero-width joiners carry no letters
    .toLowerCase();

  value = transliterateDevanagari(value);
  value = value.replace(/[śṣṛṝḷḹṃṁṅñṇḥ]/g, (ch) => LATIN_SPECIAL[ch] ?? ch);
  value = value.normalize('NFD').replace(/[̀-ͯ]/g, '');

  value = value
    // An anusvara before a labial, or at the end of a word, is m; otherwise n.
    .replace(new RegExp(`${NASAL}(?=[pbm]|[^a-z]|$)`, 'g'), 'm')
    .replace(new RegExp(NASAL, 'g'), 'n')
    .replace(/w/g, 'v')
    .replace(/ch+/g, 'c')
    .replace(/a{2,}/g, 'a')
    .replace(/(?:i{2,}|e{2,})/g, 'i')
    .replace(/(?:u{2,}|o{2,})/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!value) {
    return '';
  }

  return value.split(' ').map(dropFinalSchwa).join(' ');
}
