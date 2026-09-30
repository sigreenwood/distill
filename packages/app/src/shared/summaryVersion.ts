export interface SummaryVersionDTO {
  /** A real summary_versions.id, or the synthetic id 'current' — see buildVersionList in main/summaryVersions.ts. */
  id: string;
  summaryText: string;
  model: string;
  meetingTypeName: string;
  isActive: boolean;
  createdAt: number;
}
