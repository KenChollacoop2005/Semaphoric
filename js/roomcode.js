const ADJECTIVES = [
  'amber', 'azure', 'bold', 'brave', 'bright', 'calm', 'clever', 'cobalt',
  'crimson', 'dusty', 'eager', 'electric', 'fast', 'fuzzy', 'gentle', 'golden',
  'green', 'hidden', 'hollow', 'humble', 'icy', 'jade', 'keen', 'lucky',
  'lunar', 'mellow', 'misty', 'neon', 'noble', 'odd', 'olive', 'pale',
  'plain', 'quiet', 'rapid', 'rusty', 'sandy', 'sharp', 'silent', 'silver',
  'sleepy', 'solar', 'steady', 'stormy', 'sunny', 'swift', 'tidy', 'violet',
  'vivid', 'warm', 'wild', 'windy', 'wise', 'young', 'zesty', 'polar',
  'copper', 'crisp', 'dapper', 'frosty', 'grand', 'jolly', 'merry', 'proud',
];
const NOUNS = [
  'falcon', 'otter', 'badger', 'beacon', 'bison', 'cactus', 'canyon', 'comet',
  'coral', 'crane', 'delta', 'ember', 'fern', 'fjord', 'fox', 'gecko',
  'glacier', 'harbor', 'hawk', 'heron', 'island', 'kestrel', 'koala', 'lagoon',
  'lantern', 'lynx', 'maple', 'meadow', 'mesa', 'moose', 'nebula', 'orbit',
  'owl', 'panda', 'pebble', 'pine', 'pixel', 'plover', 'prairie', 'quartz',
  'raven', 'reef', 'river', 'robin', 'rocket', 'sable', 'signal', 'sparrow',
  'summit', 'tiger', 'topaz', 'tundra', 'valley', 'walrus', 'willow', 'yak',
  'zephyr', 'cobra', 'dune', 'finch', 'gull', 'marten', 'newt', 'puffin',
];
const CODE_DIGITS = 4;

export const ROOM_CODE_PATTERN = /^[a-z]+-[a-z]+-\d{4}$/;

// Room codes
export function generateRoomCode() {
  const r = new Uint32Array(3);
  crypto.getRandomValues(r);
  const adj = ADJECTIVES[r[0] % ADJECTIVES.length];
  const noun = NOUNS[r[1] % NOUNS.length];
  const num = String(r[2] % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
  return `${adj}-${noun}-${num}`;
}

export function normalizeRoomCode(text) {
  return text.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '');
}
