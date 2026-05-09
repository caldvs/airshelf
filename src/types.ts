export interface Book {
  id: string;
  title: string;
  author: string | null;
  year: number | null;
  /** Series name parsed from the original title's `(Series #N)` parenthetical, when present. */
  series: string | null;
  /** 1-based index within the series. Optional even when `series` is set — some books just say `(Series)`. */
  seriesIndex: number | null;
  originalName: string;
  originalFile: string;
  file: string;
  cover: string | null;
  size: number;
  ext: string;
  sourceExt: string;
  converted: boolean;
  addedAt: number;
}

// Shape returned to the renderer (enriched with derived fields)
export interface BookDTO extends Book {
  coverUrl: string | null;
  sizeHuman: string;
}

export interface OpenLibraryDoc {
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
  edition_key?: string[];
}

// Discriminated union mirroring main.ts addBook(). Exactly one of book /
// duplicate / error is set per result. Callers should pattern-match
// rather than reading optional fields off a wide shape.
export type AddBookResult =
  | { book: Book; duplicate?: undefined; error?: undefined }
  | { book?: undefined; duplicate: Book; error?: undefined }
  | { book?: undefined; duplicate?: undefined; error: string };

export interface AddManyResult {
  added: Book[];
  duplicates: Array<{ path: string; title: string }>;
  errors: Array<{ path: string; error: string }>;
}

export interface ServerInfo {
  ip: string;
  port: number;
  url: string;
  running: boolean;
}
