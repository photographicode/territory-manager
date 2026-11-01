import { useState } from 'react';
import type { PageProps } from '../App';
import { download } from '../geo/kml';
import { newProject, type Project } from '../types';

export default function SettingsPage({ project, replace }: PageProps) {
  const [msg, setMsg] = useState('');

  function backup() {
    const name = `territory-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
    download(name, JSON.stringify(project), 'application/json');
  }

  async function restore(f: File | undefined) {
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as Project;
      if (data.version !== 1 || !Array.isArray(data.territories)) throw new Error('This is not a Territory Manager backup');
      if (!confirm(`Replace everything with this backup (${data.territories.length} territories, ${data.assignments?.length ?? 0} records)?`)) return;
      replace({ ...newProject(), ...data, settings: { ...newProject().settings, ...data.settings } });
      setMsg('Backup restored.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="page narrow">
      <h2>Backup and restore</h2>
      <p className="muted">
        Everything is saved in this browser on this device only. Download a backup regularly, and use it to move your work to another computer.
      </p>
      <div className="toolbar">
        <button className="btn primary" onClick={backup}>
          Download backup
        </button>
        <label className="file">
          <input type="file" accept=".json" onChange={(e) => restore(e.target.files?.[0])} />
          <span className="btn">Restore from backup…</span>
        </label>
      </div>
      {msg && <p className="status">{msg}</p>}
      <h3>Start over</h3>
      <button
        className="btn danger"
        onClick={() => {
          if (confirm('Erase the boundary, all territories and all assignment records from this browser? Download a backup first.')) replace(newProject());
        }}
      >
        Erase everything
      </button>
    </div>
  );
}
