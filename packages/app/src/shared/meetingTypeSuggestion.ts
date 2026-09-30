export interface MeetingTypeSuggestion {
  meetingTypeId: string;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
}
