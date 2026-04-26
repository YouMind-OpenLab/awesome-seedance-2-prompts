import 'dotenv/config';
import { stringify } from 'qs-esm';

const CMS_HOST = process.env.CMS_HOST!;
const CMS_API_KEY = process.env.CMS_API_KEY!;

export interface VideoPrompt {
  id: number;
  title: string;
  content: string;
  description?: string;
  language: string;
  model: string;
  featured?: boolean;
  sort?: number | null;
  author?: { name: string; link?: string };
  sourceLink?: string;
  sourcePublishedAt?: string;
  translatedContent?: string;
  sourceVideos?: Array<{ url: string; thumbnail?: string }>;
  videos?: Array<{
    cloudflareStream?: { thumbnailUrl?: string; uid?: string };
    poster?: { url?: string };
  }>;
  results?: {
    docs: Array<{
      video?: {
        cloudflareStream?: { thumbnailUrl?: string };
        poster?: { url?: string };
      };
      model?: { slug?: string };
    }>;
  };
  referenceImages?: Array<{ url?: string } | number>;
  sourceReferenceImages?: string[];
  media?: Array<{
    url?: string;
    thumbnailURL?: string;
    sizes?: {
      thumbnail?: { url?: string };
      small?: { url?: string };
    };
  } | number>;
  sourceMedia?: string[];
}

export interface ProcessedPrompt {
  id: number;
  title: string;
  content: string;
  translatedContent?: string;
  description?: string;
  language: string;
  author?: { name: string; link?: string };
  sourceLink?: string;
  sourcePublishedAt?: string;
  thumbnail: string;
  referenceImages?: string[];
  mediaImages?: string[];
  featured?: boolean;
  videoUrl?: string;
}

export interface FetchResult {
  prompts: ProcessedPrompt[];
  /** Total prompt count in CMS (regardless of thumbnail availability) */
  totalDocs: number;
}

function extractThumbnail(doc: VideoPrompt): string | null {
  // 1. From videos[]
  if (doc.videos && Array.isArray(doc.videos)) {
    for (const v of doc.videos) {
      if (v.cloudflareStream?.thumbnailUrl) return v.cloudflareStream.thumbnailUrl;
      if (v.poster?.url) return v.poster.url;
    }
  }

  // 2. From results.docs[].video
  if (doc.results?.docs && Array.isArray(doc.results.docs)) {
    for (const r of doc.results.docs) {
      if (typeof r !== 'object' || !r) continue;
      if (r.video?.cloudflareStream?.thumbnailUrl) return r.video.cloudflareStream.thumbnailUrl;
      if (r.video?.poster?.url) return r.video.poster.url;
    }
  }

  // 3. From sourceVideos[]
  if (doc.sourceVideos && Array.isArray(doc.sourceVideos)) {
    for (const sv of doc.sourceVideos) {
      if (sv.thumbnail) return sv.thumbnail;
    }
  }

  // 4. From media[] (image-based prompts — use CDN thumbnail sizes if available)
  if (doc.media && Array.isArray(doc.media)) {
    for (const m of doc.media) {
      if (typeof m === 'object' && m !== null) {
        const mo = m as { url?: string; thumbnailURL?: string; sizes?: { thumbnail?: { url?: string }; small?: { url?: string } } };
        if (mo.sizes?.thumbnail?.url) return mo.sizes.thumbnail.url;
        if (mo.sizes?.small?.url) return mo.sizes.small.url;
        if (mo.url) return mo.url;
      }
    }
  }

  // 5. From sourceMedia[] (fallback)
  if (doc.sourceMedia && Array.isArray(doc.sourceMedia)) {
    for (const url of doc.sourceMedia) {
      if (url) return url;
    }
  }

  return null;
}

const SHARED_QUERY_PARAMS = (locale: string) => ({
  sort: '-sourcePublishedAt',
  depth: 2,
  locale,
  select: { sourceMeta: false, raw: false },
});

function processDoc(doc: VideoPrompt): ProcessedPrompt | null {
  const thumbnail = extractThumbnail(doc);
  if (!thumbnail) {
    console.log(`Skipping "${doc.title}" — no thumbnail`);
    return null;
  }

  // Extract reference images
  const refImgs: string[] = [];
  if (doc.referenceImages?.length) {
    for (const img of doc.referenceImages) {
      if (typeof img === 'object' && img !== null && img.url) refImgs.push(img.url);
    }
  }
  if (!refImgs.length && doc.sourceReferenceImages?.length) {
    for (const url of doc.sourceReferenceImages) { if (url) refImgs.push(url); }
  }

  // Extract media images
  const mediaImgs: string[] = [];
  if (doc.media?.length) {
    for (const m of doc.media) {
      if (typeof m === 'object' && m !== null) {
        const mo = m as { url?: string };
        if (mo.url) mediaImgs.push(mo.url);
      }
    }
  }
  if (!mediaImgs.length && doc.sourceMedia?.length) {
    for (const url of doc.sourceMedia) { if (url) mediaImgs.push(url); }
  }

  // Extract video URL from sourceVideos or cloudflareStream
  let videoUrl: string | undefined;
  if (doc.sourceVideos?.length) {
    for (const sv of doc.sourceVideos) {
      if (sv.url) { videoUrl = sv.url; break; }
    }
  }
  if (!videoUrl && doc.videos?.length) {
    for (const v of doc.videos) {
      if (v.cloudflareStream?.uid) {
        videoUrl = `cloudflare:${v.cloudflareStream.uid}`;
        break;
      }
    }
  }

  return {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    translatedContent: doc.translatedContent || undefined,
    description: doc.description || undefined,
    language: doc.language,
    author: doc.author && typeof doc.author === 'object' ? doc.author : undefined,
    sourceLink: doc.sourceLink || undefined,
    sourcePublishedAt: doc.sourcePublishedAt || undefined,
    thumbnail,
    referenceImages: refImgs.length ? refImgs : undefined,
    mediaImages: mediaImgs.length ? mediaImgs : undefined,
    featured: doc.featured || false,
    videoUrl,
  };
}

export interface FilterCategory {
  id: number;
  title: string;
  slug: string;
  parentId: number | null;
  parentSlug: string | null;
  featured: boolean;
  sort: number | null;
}

interface CMSCategoryDoc {
  id: number;
  title: string;
  slug: string;
  parent?: number | { id: number; slug?: string } | null;
  featured?: boolean;
  sort?: number | null;
}

const SEEDANCE_CATEGORY_CAMPAIGN = 'seedance-2.0-prompts';

export async function fetchPromptCategories(locale: string = 'en-US'): Promise<FilterCategory[]> {
  const query = stringify({
    limit: 999,
    sort: 'sort',
    locale,
    depth: 0,
    where: {
      campaign: { in: [SEEDANCE_CATEGORY_CAMPAIGN] },
    },
  }, { addQueryPrefix: true });

  const url = `${CMS_HOST}/api/prompt-categories${query}`;
  const res = await fetch(url, {
    headers: { Authorization: `users API-Key ${CMS_API_KEY}` },
  });
  if (!res.ok) throw new Error(`CMS category error: ${res.status} ${await res.text()}`);

  const data = await res.json() as { docs: CMSCategoryDoc[] };

  return data.docs.map((cat) => {
    let parentId: number | null = null;
    let parentSlug: string | null = null;
    if (cat.parent != null) {
      if (typeof cat.parent === 'number') {
        parentId = cat.parent;
      } else {
        parentId = cat.parent.id;
        parentSlug = cat.parent.slug ?? null;
      }
    }
    return {
      id: cat.id,
      title: cat.title,
      slug: cat.slug,
      parentId,
      parentSlug,
      featured: cat.featured ?? false,
      sort: cat.sort ?? null,
    };
  });
}

export async function fetchSeedancePrompts(locale: string = 'en'): Promise<FetchResult> {
  const authHeader = { Authorization: `users API-Key ${CMS_API_KEY}` };

  // --- 1. Fetch latest prompts (recent 200) ---
  const mainQuery = stringify({
    where: { model: { equals: 'seedance-2.0' } },
    limit: 200,
    ...SHARED_QUERY_PARAMS(locale),
  }, { addQueryPrefix: true });

  const mainUrl = `${CMS_HOST}/api/video-prompts${mainQuery}`;
  console.log('Fetching latest prompts:', mainUrl);

  const mainRes = await fetch(mainUrl, { headers: authHeader });
  if (!mainRes.ok) throw new Error(`CMS error: ${mainRes.status} ${await mainRes.text()}`);

  const mainData = await mainRes.json() as { docs: VideoPrompt[]; totalDocs: number };
  console.log(`Total docs in CMS: ${mainData.totalDocs}, fetched: ${mainData.docs.length}`);

  // --- 2. Fetch all featured prompts separately (they may be older than limit:200) ---
  const featuredQuery = stringify({
    where: { model: { equals: 'seedance-2.0' }, featured: { equals: true } },
    sort: 'sort',          // sort by the CMS 'sort' field (asc = hand-curated order)
    limit: 100,
    depth: 2,
    locale,
    select: { sourceMeta: false, raw: false },
  }, { addQueryPrefix: true });

  const featuredUrl = `${CMS_HOST}/api/video-prompts${featuredQuery}`;
  console.log('Fetching featured prompts:', featuredUrl);

  const featuredRes = await fetch(featuredUrl, { headers: authHeader });
  if (!featuredRes.ok) throw new Error(`CMS featured error: ${featuredRes.status} ${await featuredRes.text()}`);

  const featuredData = await featuredRes.json() as { docs: VideoPrompt[]; totalDocs: number };
  console.log(`Featured prompts in CMS: ${featuredData.totalDocs}`);

  // --- 3. Merge: featured first, then latest (deduped by ID) ---
  const seenIds = new Set<number>();
  const allDocs: VideoPrompt[] = [];

  for (const doc of featuredData.docs) {
    seenIds.add(doc.id);
    allDocs.push(doc);
  }
  for (const doc of mainData.docs) {
    if (!seenIds.has(doc.id)) {
      seenIds.add(doc.id);
      allDocs.push(doc);
    }
  }

  // --- 4. Process and filter by thumbnail ---
  const results: ProcessedPrompt[] = [];
  for (const doc of allDocs) {
    const processed = processDoc(doc);
    if (processed) results.push(processed);
  }

  console.log(`Prompts with thumbnails: ${results.length} (featured: ${results.filter(p => p.featured).length})`);

  return {
    prompts: results,
    totalDocs: mainData.totalDocs,
  };
}
