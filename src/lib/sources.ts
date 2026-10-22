// Curated, identifiable sources for the factual claims articles are allowed to
// make. One definition shared by the seeding script (which writes them into
// content_sources) and the quality gate (which decides whether a claim has
// provenance).
//
// Reachability of every URL here was checked on 2026-10-20. Several official
// sites reject automated requests with 403; that is recorded rather than hidden,
// because a 403 from an official domain still identifies a real source, while a
// 404 or a DNS failure does not.

export type CuratedSource = {
  sourceName: string;
  sourceUrl: string;
  sourceType:
    | "airport"
    | "rail"
    | "road"
    | "licensing"
    | "council"
    | "weather"
    | "education"
    | "tourism";
  notes: string;
};

export const CURATED_SOURCES: CuratedSource[] = [
  {
    sourceName: "Gatwick Airport (official)",
    sourceUrl: "https://www.gatwickairport.com/",
    sourceType: "airport",
    notes:
      "Authoritative for Gatwick terminals, North and South Terminal layout, the inter-terminal shuttle, and official guidance on arrivals and departures.",
  },
  {
    sourceName: "National Rail Enquiries",
    sourceUrl: "https://www.nationalrail.co.uk/",
    sourceType: "rail",
    notes:
      "Authoritative for which stations exist, station facilities, timetable and engineering-work information across the Great Britain rail network.",
  },
  {
    sourceName: "National Rail travel information",
    sourceUrl: "https://www.nationalrail.co.uk/travel-information/",
    sourceType: "rail",
    notes:
      "Authoritative for disruption, accessibility assistance, and advice on planning around planned engineering work.",
  },
  {
    sourceName: "Southern Railway",
    sourceUrl: "https://www.southernrailway.com/",
    sourceType: "rail",
    notes:
      "Operator for the Brighton Main Line and Sussex coastal routes, including Brighton, Hove, Lewes, Haywards Heath, Three Bridges, Horsham and Worthing.",
  },
  {
    sourceName: "Thameslink",
    sourceUrl: "https://www.thameslinkrailway.com/",
    sourceType: "rail",
    notes:
      "Operator for cross-London services via Gatwick Airport, East Croydon, London Blackfriars, Farringdon and St Pancras International.",
  },
  {
    sourceName: "Gatwick Express",
    sourceUrl: "https://www.gatwickexpress.com/",
    sourceType: "rail",
    notes:
      "Operator of the dedicated London Victoria to Gatwick Airport service.",
  },
  {
    sourceName: "National Highways",
    sourceUrl: "https://nationalhighways.co.uk/",
    sourceType: "road",
    notes:
      "Authoritative for motorway and major A-road conditions, roadworks and closures on the M23, M25 and A23 corridors.",
  },
  {
    sourceName: "GOV.UK taxi and private hire vehicle licensing",
    sourceUrl:
      "https://www.gov.uk/transport/taxi-and-private-hire-vehicle-licensing",
    sourceType: "licensing",
    notes:
      "Authoritative for the legal distinction between hackney carriages and private hire vehicles, and for the requirement that private hire journeys be pre-booked through a licensed operator.",
  },
  {
    sourceName: "GOV.UK taxi driver licence requirements",
    sourceUrl: "https://www.gov.uk/taxi-driver-licence",
    sourceType: "licensing",
    notes:
      "Authoritative for driver licensing requirements, including that licensing is granted by the local council and that drivers must pass background checks.",
  },
  {
    sourceName: "Transport for London",
    sourceUrl: "https://tfl.gov.uk/",
    sourceType: "rail",
    notes:
      "Authoritative for London Underground, bus, Elizabeth line and contactless/Oyster fare rules. The site returns HTTP 403 to automated checks; the domain is a verified public body.",
  },
  {
    sourceName: "Brighton & Hove City Council",
    sourceUrl: "https://www.brighton-hove.gov.uk/",
    sourceType: "council",
    notes:
      "Licensing authority for taxis and private hire in Brighton & Hove, and authoritative for local parking, bus lane and event road-closure rules. The site rate-limits automated checks.",
  },
  {
    sourceName: "Crawley Borough Council",
    sourceUrl: "https://crawley.gov.uk/",
    sourceType: "council",
    notes:
      "Licensing authority for taxis and private hire in Crawley, which includes the area around Gatwick Airport and Three Bridges.",
  },
  {
    sourceName: "Mid Sussex District Council",
    sourceUrl: "https://www.midsussex.gov.uk/",
    sourceType: "council",
    notes:
      "Licensing authority covering Haywards Heath, Burgess Hill and East Grinstead.",
  },
  {
    sourceName: "Adur & Worthing Councils",
    sourceUrl: "https://www.adur-worthing.gov.uk/",
    sourceType: "council",
    notes:
      "Licensing authority covering Worthing, Shoreham-by-Sea and Lancing.",
  },
  {
    sourceName: "Reigate & Banstead Borough Council",
    sourceUrl: "https://www.reigate-banstead.gov.uk/",
    sourceType: "council",
    notes: "Licensing authority covering Reigate, Redhill and Horley.",
  },
  {
    sourceName: "Horsham District Council",
    sourceUrl: "https://www.horsham.gov.uk/",
    sourceType: "council",
    notes:
      "Licensing authority covering Horsham and the surrounding district. The site returns HTTP 403 to automated checks.",
  },
  {
    sourceName: "Lewes & Eastbourne Councils",
    sourceUrl: "https://www.lewes-eastbourne.gov.uk/",
    sourceType: "council",
    notes:
      "Licensing authority covering Lewes and Newhaven. The site returns HTTP 403 to automated checks.",
  },
  {
    sourceName: "West Sussex County Council roads and travel",
    sourceUrl: "https://www.westsussex.gov.uk/roads-and-travel/",
    sourceType: "council",
    notes:
      "Authoritative for county road maintenance, local roadworks and community transport schemes in West Sussex.",
  },
  {
    sourceName: "East Sussex County Council",
    sourceUrl: "https://www.eastsussex.gov.uk/",
    sourceType: "council",
    notes:
      "Authoritative for county roads, local transport and community transport schemes in East Sussex.",
  },
  {
    sourceName: "Surrey County Council",
    sourceUrl: "https://www.surreycc.gov.uk/",
    sourceType: "council",
    notes:
      "Authoritative for county roads and local transport in Surrey, including Reigate, Redhill and Horley.",
  },
  {
    sourceName: "Met Office",
    sourceUrl: "https://www.metoffice.gov.uk/",
    sourceType: "weather",
    notes:
      "Authoritative for UK weather warnings that affect journey planning. Never cite a specific forecast in an evergreen article.",
  },
  {
    sourceName: "University of Sussex",
    sourceUrl: "https://www.sussex.ac.uk/",
    sourceType: "education",
    notes:
      "Authoritative for the Falmer campus location, term dates and campus travel guidance.",
  },
  {
    sourceName: "University of Brighton",
    sourceUrl: "https://www.brighton.ac.uk/",
    sourceType: "education",
    notes:
      "Authoritative for Brighton campus locations and student travel guidance.",
  },
  {
    sourceName: "VisitBrighton (official visitor information)",
    sourceUrl: "https://www.visitbrighton.com/",
    sourceType: "tourism",
    notes:
      "Official destination information for Brighton attractions, venues and event listings.",
  },
];

// Domains an article may cite. Anything else in the body is treated as a
// fabricated or unvetted citation, which is one of the easiest ways for a
// generated article to look authoritative while being wrong.
const EXTRA_TRUSTED_SUFFIXES = [
  ".gov.uk",
  ".ac.uk",
  ".nhs.uk",
  ".police.uk",
  "nationalrail.co.uk",
  "westerncars.com",
  "westerncarsbrighton.co.uk",
] as const;

export function trustedHostnames(): Set<string> {
  const hosts = new Set<string>();

  for (const source of CURATED_SOURCES) {
    try {
      hosts.add(new URL(source.sourceUrl).hostname.toLowerCase());
    } catch {
      // A malformed curated URL is a code bug, not a runtime condition.
      console.error(`Curated source has malformed URL: ${source.sourceUrl}`);
    }
  }

  return hosts;
}

export function isTrustedCitation(
  rawUrl: string,
  approvedHostnames: Iterable<string> = trustedHostnames(),
) {
  let host: string;

  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }

    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const approved of approvedHostnames) {
    const normalised = approved.toLowerCase();

    if (host === normalised || host.endsWith(`.${normalised}`)) {
      return true;
    }
  }

  return EXTRA_TRUSTED_SUFFIXES.some(
    (suffix) =>
      host === suffix.replace(/^\./, "") ||
      host.endsWith(suffix.startsWith(".") ? suffix : `.${suffix}`),
  );
}
