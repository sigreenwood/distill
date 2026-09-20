import { PlaudAuth } from './auth.js';
import { BASE_URLS } from './types.js';
import type { PlaudRecording, PlaudRecordingDetail, PlaudUserInfo } from './types.js';

/**
 * The slice of the Plaud response shape we care about for region
 * redirection. Plaud uses HTTP 200 with a body-level `status: -302`
 * to signal "you hit the wrong region"; the `data.domains.api` field
 * names the correct base. Any other response is opaque to the type
 * system (the API has no published schema), so we keep this narrow
 * and let `request()` return `unknown` for non-302 cases.
 */
interface RegionRedirectResponse {
  status: number;
  data?: {
    domains?: {
      api?: string;
    };
  };
}

function isRegionRedirect(v: unknown): v is RegionRedirectResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { status?: unknown };
  return o.status === -302;
}

export class PlaudClient {
  private auth: PlaudAuth;
  private region: string;

  constructor(auth: PlaudAuth, region: string = 'us') {
    this.auth = auth;
    this.region = region;
  }

  private get baseUrl(): string {
    return BASE_URLS[this.region] ?? BASE_URLS['us'];
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as unknown;

    // Handle region mismatch. Plaud signals this with a body-level
    // `status: -302` rather than an HTTP redirect. We probe for the
    // narrow shape; anything else falls through unchanged.
    if (isRegionRedirect(data)) {
      const domain = data.data?.domains?.api;
      if (domain) {
        this.region = domain.includes('euc1') ? 'eu' : 'us';
        return this.request(path, options);
      }
    }

    return data;
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    // Captured from Plaud Web. `skip`/`limit` are the endpoint's actual
    // history controls; page/page_size are not supported. `is_trash=2`
    // requests both active and trashed rows, then we filter trash locally
    // for consistent behaviour with older API responses.
    const data = await this.request(
      '/file/simple/web?skip=0&limit=99999&is_trash=2&sort_by=start_time&is_desc=true',
    );
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? [];
    return list.filter((recording) => !recording.is_trash);
  }

  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;

    let transcript = '';
    const preDownload: any[] = raw.pre_download_content_list ?? [];
    for (const item of preDownload) {
      const content = item.data_content ?? '';
      if (content.length > transcript.length) transcript = content;
    }

    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript,
    } as PlaudRecordingDetail;
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/user/me');
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? 'unknown',
    };
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async getMp3Url(id: string): Promise<string | null> {
    // Errors fall into two buckets:
    //   - Recording gone server-side (HTTP 404 from temp-url endpoint).
    //     These are legitimately "no URL available" and we return null
    //     so the caller can surface a friendlier "deleted" message.
    //   - Anything else (auth failure, network error, region redirect
    //     loop, etc.). These are real failures and we let them propagate
    //     so the caller can prettify them properly. Swallowing all
    //     errors here silently routed auth failures ("No credentials
    //     configured") into the same "no URL" path, which lost the
    //     actual reason.
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "Plaud API error: 404 Not Found" comes from request() above.
      if (/Plaud API error:\s*404\b/i.test(msg)) return null;
      throw e;
    }
  }
}
