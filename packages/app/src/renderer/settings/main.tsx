import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  GeneralDTO,
  MeetingTypeDTO,
  ModelSuggestionDTO,
  OutputsDTO,
  PerformanceDTO,
  SourcesDTO,
  SystemInfoDTO,
  VocabularyScopeDTO,
} from '../shared/api.js';
import { TabButton, headerStyle, readTabFromHash, shellStyle, tabBarStyle } from './ui.jsx';
import {
  AboutPane,
  GeneralPane,
  OutputsPane,
  PerformancePane,
  PromptsPane,
  SourcesPane,
  VocabularyPane,
} from './panes.jsx';

function Settings() {
  const [tab, setTab] = useState(() => readTabFromHash());
  const [outputs, setOutputs] = useState<OutputsDTO | null>(null);
  const [prompts, setPrompts] = useState<MeetingTypeDTO[] | null>(null);
  const [vocabularyScopes, setVocabularyScopes] = useState<VocabularyScopeDTO[] | null>(null);
  const [general, setGeneral] = useState<GeneralDTO | null>(null);
  const [performance, setPerformance] = useState<PerformanceDTO | null>(null);
  const [sources, setSources] = useState<SourcesDTO | null>(null);
  const [system, setSystem] = useState<SystemInfoDTO | null>(null);
  const [modelSuggestion, setModelSuggestion] = useState<ModelSuggestionDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.distill.settings.load();
        setOutputs(s.outputs);
        setPrompts(s.prompts);
        setVocabularyScopes(s.vocabularyScopes);
        setGeneral(s.general);
        setPerformance(s.performance);
        setSources(s.sources);
        setSystem(s.system);
        setModelSuggestion(s.modelSuggestion);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      setTab(readTabFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (loadError && (!outputs || !prompts || !vocabularyScopes || !general || !performance || !sources)) {
    return (
      <div style={shellStyle}>
        <div style={{ padding: 24, color: 'var(--danger)' }}>Could not load settings: {loadError}</div>
      </div>
    );
  }
  if (!outputs || !prompts || !vocabularyScopes || !general || !performance || !sources) {
    return (
      <div style={shellStyle}>
        <div style={{ padding: 24, color: 'var(--fg-muted)' }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <header style={headerStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Settings</div>
      </header>
      <div style={tabBarStyle} role="tablist">
        <TabButton label="Sources" active={tab === 'sources'} onClick={() => setTab('sources')} />
        <TabButton label="Outputs" active={tab === 'outputs'} onClick={() => setTab('outputs')} />
        <TabButton label="Prompts" active={tab === 'prompts'} onClick={() => setTab('prompts')} />
        <TabButton label="Vocabulary" active={tab === 'vocabulary'} onClick={() => setTab('vocabulary')} />
        <TabButton label="General" active={tab === 'general'} onClick={() => setTab('general')} />
        <TabButton
          label="Performance"
          active={tab === 'performance'}
          onClick={() => setTab('performance')}
        />
        <TabButton label="About" active={tab === 'about'} onClick={() => setTab('about')} />
      </div>
      {/* Panes stay mounted and are shown/hidden so per-pane edits survive tab switches. */}
      <div style={{ display: tab === 'sources' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <SourcesPane initial={sources} onChanged={(next) => setSources(next)} />
      </div>
      <div style={{ display: tab === 'outputs' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <OutputsPane initial={outputs} onSaved={(next) => setOutputs(next)} />
      </div>
      <div style={{ display: tab === 'prompts' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <PromptsPane initial={prompts} onChanged={(next) => setPrompts(next)} />
      </div>
      <div style={{ display: tab === 'vocabulary' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <VocabularyPane
          initialScopes={vocabularyScopes}
          onScopeSaved={(updated) =>
            setVocabularyScopes((prev) => (prev ? prev.map((s) => (s.id === updated.id ? updated : s)) : prev))
          }
        />
      </div>
      <div style={{ display: tab === 'general' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <GeneralPane initial={general} onSaved={(next) => setGeneral(next)} />
      </div>
      <div style={{ display: tab === 'performance' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <PerformancePane
          initial={performance}
          onSaved={(next) => setPerformance(next)}
          suggestion={modelSuggestion}
        />
      </div>
      <div style={{ display: tab === 'about' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <AboutPane system={system ?? undefined} />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Settings renderer: #root not found');
createRoot(root).render(<Settings />);
