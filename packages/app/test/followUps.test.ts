import { describe, expect, it } from 'vitest';
import { extractFollowUps, followUpCountLabel } from '../src/shared/followUps.js';

describe('extractFollowUps', () => {
  it('reads the current customer prompt: grouped checkboxes, owners and due dates', () => {
    const f = extractFollowUps(`Weekly sync on upgrade dates and support issues
## Actions
**Teradata**
- [ ] Alex Smith — Confirm the upgrade window — 14 November
- [ ] Owner unclear — Send the revised plan — (Not stated)
**Customer**
- [ ] None agreed.

## Summary
The call covered the upgrade.

## Decisions
- The upgrade stays on 6 November.
- Two workshops will be organised.

## Risks and escalations
- Backup space is short.`);
    expect(f.actions).toEqual([
      { text: 'Confirm the upgrade window', owner: 'Alex Smith', due: '14 November', group: 'Teradata' },
      { text: 'Send the revised plan', owner: null, due: null, group: 'Teradata' },
    ]);
    expect(f.decisions.map((d) => d.text)).toEqual(['The upgrade stays on 6 November.', 'Two workshops will be organised.']);
  });

  it('finds nothing in a summary that agreed nothing', () => {
    const f = extractFollowUps('No meeting content recorded\n## Actions\n- None agreed.');
    expect(f).toEqual({ actions: [], decisions: [] });
  });

  it('keeps a long last part as the action, not a due date', () => {
    const [a] = extractFollowUps(
      '## Actions\n- [ ] Pat Lee — **Acme** — Check with the platform team about the dashboard extract',
    ).actions;
    expect(a).toMatchObject({ owner: 'Pat Lee', due: null, text: 'Acme — Check with the platform team about the dashboard extract' });
  });

  it('reads the club minutes table and inline decisions', () => {
    const f = extractFollowUps(`Work party dates agreed and fees held
## Actions
| # | Action | Owner | Deadline | Agenda item |
|---|--------|-------|----------|-------------|
| 1 | Book the work party | Chris Jones | 1 March | 9 |
| 2 | Renew the lease | Owner unclear | Not stated | 8 |

## Agenda
### 8. Finance
- **Summary:** The Treasurer presented the accounts.
- **Decisions and votes:** Fees held at £60, carried unanimously.
### 9. Work parties
- **Summary:** Not discussed.`);
    expect(f.actions).toEqual([
      { text: 'Book the work party', owner: 'Chris Jones', due: '1 March', group: null },
      { text: 'Renew the lease', owner: null, due: null, group: null },
    ]);
    expect(f.decisions.map((d) => d.text)).toEqual(['Fees held at £60, carried unanimously.']);
  });

  it('reads older shapes: ticks, "Name to …" and nested Owner/Timeframe', () => {
    const f = extractFollowUps(`### Follow-Up Actions and Assignments

✅ Sam to email the analyst about the schema.
✅ [Data Team] to review the analysis in two weeks.

### Unresolved Topics
- Something open.

## 1.4 Calls to action (do this next)
- **Action**: Engage the specialist team
  - Owner: Account teams
  - Timeframe: Ongoing
  - Evidence: "we should loop them in"`);
    expect(f.actions).toEqual([
      { text: 'email the analyst about the schema.', owner: 'Sam', due: null, group: null },
      { text: 'review the analysis in two weeks.', owner: 'Data Team', due: null, group: null },
      { text: 'Engage the specialist team', owner: 'Account teams', due: 'Ongoing', group: null },
    ]);
  });

  it('treats a bold "Person:" bullet with children as a group', () => {
    const f = extractFollowUps(`# Follow-ups & Commitments

*   **Kim Ray:**
    *   Will fix the sign-in bugs.
    *   Will check account access.
*   **Field Teams:**
    *   Submit demo recordings.

# Other notes
- Not an action.`);
    expect(f.actions.map((a) => [a.group, a.text])).toEqual([
      ['Kim Ray', 'Will fix the sign-in bugs.'],
      ['Kim Ray', 'Will check account access.'],
      ['Field Teams', 'Submit demo recordings.'],
    ]);
  });

  it('ignores follow-up material lists and decision-maker headings', () => {
    const f = extractFollowUps('## Promised follow-up material\n- The deck\n## Decision makers\n- Jo, CIO');
    expect(f).toEqual({ actions: [], decisions: [] });
  });

  it('copes with empty input', () => {
    expect(extractFollowUps(null)).toEqual({ actions: [], decisions: [] });
    expect(extractFollowUps('   ')).toEqual({ actions: [], decisions: [] });
  });
});

describe('followUpCountLabel', () => {
  it('pluralises and omits zero counts', () => {
    expect(followUpCountLabel(3, 1)).toBe('3 actions · 1 decision');
    expect(followUpCountLabel(1, 0)).toBe('1 action');
    expect(followUpCountLabel(0, 0)).toBe('');
  });
});
