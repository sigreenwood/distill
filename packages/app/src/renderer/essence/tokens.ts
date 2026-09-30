export const ESSENCE_STATES = {
  "idle": {
    "label": "Ready",
    "start": "#FFBE45",
    "end": "#D47506"
  },
  "waiting": {
    "label": "New recordings waiting",
    "start": "#FFBE45",
    "end": "#D47506"
  },
  "downloading": {
    "label": "Downloading or importing",
    "start": "#60A5FA",
    "end": "#2563EB"
  },
  "transcribing": {
    "label": "Transcribing",
    "start": "#2DD4BF",
    "end": "#0D9488"
  },
  "summarising": {
    "label": "Summarising or preparing a brief",
    "start": "#A78BFA",
    "end": "#7656CE"
  },
  "complete": {
    "label": "Processing complete",
    "start": "#4ADE80",
    "end": "#16A34A"
  },
  "paused": {
    "label": "Paused",
    "start": "#B9BFCA",
    "end": "#7A8494"
  },
  "error": {
    "label": "Needs attention",
    "start": "#FB8B72",
    "end": "#DA5448"
  }
} as const;
export type EssenceActivity = keyof typeof ESSENCE_STATES;
export const ESSENCE_GEOMETRY = {
  "drop": "M128 20 C114 48 98 66 76 92 C56 115 42 139 42 164 C42 211 79 236 128 236 C177 236 214 211 214 164 C214 139 200 115 180 92 C158 66 142 48 128 20 Z",
  "quoteLeft": "M116 106 C91 114 73 136 73 160 C73 181 84 192 100 192 C116 192 128 181 128 164 C128 150 120 140 111 137 C108 130 109 116 116 106 Z",
  "quoteRight": "M153 212 C175 200 187 181 187 159 C187 140 175 128 159 128 C143 128 133 141 133 158 C133 172 141 183 153 186 C157 195 156 204 153 212 Z"
} as const;
