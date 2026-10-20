// Real transport places in and around the Western Cars service area.
//
// This list exists so the quality gate can catch an invented station or airport
// — the most damaging kind of local inaccuracy, because it reads as authoritative
// and sends a reader to a place that does not exist. It is deliberately a
// recognition list, not a relevance list: a Brighton article may legitimately
// discuss Heathrow or St Pancras, so naming a real place far away is fine.
//
// Add to this list rather than loosening the check.

export const KNOWN_AIRPORTS = [
  "gatwick",
  "london gatwick",
  "gatwick north terminal",
  "gatwick south terminal",
  "heathrow",
  "london heathrow",
  "london city",
  "luton",
  "london luton",
  "stansted",
  "london stansted",
  "southend",
  "london southend",
  "southampton",
  "bournemouth",
  "brighton city",
  "shoreham",
  "biggin hill",
  "farnborough",
] as const;

export const KNOWN_STATIONS = [
  // Brighton & Hove
  "brighton",
  "hove",
  "aldrington",
  "portslade",
  "fishersgate",
  "london road",
  "london road brighton",
  "preston park",
  "moulsecoomb",
  "falmer",
  "southease",
  // Sussex
  "lewes",
  "cooksbridge",
  "plumpton",
  "glynde",
  "berwick",
  "polegate",
  "eastbourne",
  "seaford",
  "newhaven town",
  "newhaven harbour",
  "bishopstone",
  "haywards heath",
  "wivelsfield",
  "burgess hill",
  "hassocks",
  "three bridges",
  "crawley",
  "ifield",
  "horsham",
  "littlehaven",
  "christs hospital",
  "billingshurst",
  "pulborough",
  "worthing",
  "west worthing",
  "durrington on sea",
  "goring by sea",
  "angmering",
  "lancing",
  "shoreham by sea",
  "southwick",
  "east grinstead",
  "dormans",
  "lingfield",
  "hurst green",
  "oxted",
  "arundel",
  "littlehampton",
  "bognor regis",
  "chichester",
  // Surrey
  "horley",
  "gatwick airport",
  "redhill",
  "reigate",
  "earlswood",
  "salfords",
  "merstham",
  "nutfield",
  "godstone",
  "edenbridge",
  "dorking",
  "guildford",
  "woking",
  // London
  "london victoria",
  "victoria",
  "london bridge",
  "london blackfriars",
  "blackfriars",
  "st pancras",
  "london st pancras international",
  "kings cross",
  "st pancras international",
  "clapham junction",
  "east croydon",
  "west croydon",
  "london waterloo",
  "waterloo",
  "farringdon",
  "city thameslink",
  "euston",
  "paddington",
  "liverpool street",
  "london euston",
] as const;

export const KNOWN_PORTS = [
  "newhaven",
  "portsmouth",
  "dover",
  "folkestone",
  "southampton",
] as const;

const NORMALISE = /[^a-z0-9 ]+/g;

function normalise(value: string) {
  return value.toLowerCase().replace(NORMALISE, " ").replace(/\s+/g, " ").trim();
}

const AIRPORT_SET = new Set(KNOWN_AIRPORTS.map(normalise));
const STATION_SET = new Set(KNOWN_STATIONS.map(normalise));
const PORT_SET = new Set(KNOWN_PORTS.map(normalise));

// Words that precede the place noun but are not part of the name, so
// "the nearest Brighton Station" resolves to "brighton".
const LEADING_NOISE = new Set([
  "the",
  "a",
  "an",
  "at",
  "to",
  "from",
  "near",
  "nearest",
  "local",
  "your",
  "any",
  "every",
  "this",
  "that",
  "and",
  "or",
  "of",
  "in",
  "on",
  "by",
  "via",
  "for",
  "into",
  "towards",
  "toward",
  "between",
  "nearby",
  "main",
  "central",
  "train",
  "rail",
  "railway",
  "bus",
  "coach",
  "tram",
  "ferry",
  "international",
  "regional",
  "mainline",
]);

export type PlaceMention = {
  name: string;
  kind: "airport" | "station" | "port";
  recognised: boolean;
};

// Capture up to four capitalised words before Station / Airport / Port, which is
// how these names are written in running prose.
const MENTION = /((?:[A-Z][A-Za-z'’-]*(?:[ -](?=[A-Z]))?){1,4}?)[ -](Station|Airport|Terminal|Port|Harbour)\b/g;

function stripNoise(raw: string) {
  const parts = normalise(raw).split(" ").filter(Boolean);

  while (parts.length > 1 && LEADING_NOISE.has(parts[0])) {
    parts.shift();
  }

  return parts.join(" ");
}

/**
 * Find every transport place the text names and say whether it is one we
 * recognise. An unrecognised name is the signal the quality gate acts on.
 */
export function findPlaceMentions(text: string): PlaceMention[] {
  const found = new Map<string, PlaceMention>();

  for (const match of text.matchAll(MENTION)) {
    const noun = match[2].toLowerCase();
    const name = stripNoise(match[1]);

    if (!name || LEADING_NOISE.has(name)) {
      continue;
    }

    const kind: PlaceMention["kind"] =
      noun === "airport" || noun === "terminal"
        ? "airport"
        : noun === "port" || noun === "harbour"
          ? "port"
          : "station";

    // "Gatwick Airport Station" is a station whose name contains "airport".
    const candidates = [name, `${name} ${noun}`];

    const recognised = candidates.some((candidate) =>
      kind === "airport"
        ? AIRPORT_SET.has(candidate)
        : kind === "port"
          ? PORT_SET.has(candidate) || STATION_SET.has(candidate)
          : STATION_SET.has(candidate) || AIRPORT_SET.has(candidate),
    );

    const key = `${kind}:${name}`;

    if (!found.has(key)) {
      found.set(key, { name, kind, recognised });
    }
  }

  return [...found.values()];
}

export function isKnownPlaceName(value: string) {
  const name = normalise(value);
  return AIRPORT_SET.has(name) || STATION_SET.has(name) || PORT_SET.has(name);
}
