export interface Book {
  id: string;
  title: string;
  author: string | null;
  year: number | null;
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

export interface AddBookResult {
  book?: Book;
  error?: string;
}

export interface AddManyResult {
  added: Book[];
  errors: Array<{ path: string; error: string }>;
}

export interface ServerInfo {
  ip: string;
  port: number;
  url: string;
  running: boolean;
}
