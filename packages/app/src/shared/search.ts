export type SearchScope = 'summary' | 'transcript';
export interface MeetingSearchResult {
  id: string;
  title: string;
  date: number;
  client: string | null;
  source: SearchScope;
  excerpts: string[];
  canReveal: boolean;
}
export interface MeetingSearchResponse {
  scope: SearchScope;
  results: MeetingSearchResult[];
  searched: number;
  unavailable: number;
  totalMatches: number;
  terms: string[][];
  warning: string | null;
}
