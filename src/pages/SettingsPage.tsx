import { useState } from 'react';
import type { PageProps } from '../App';
import { download } from '../geo/kml';
import { newProject, type Project } from '../types';
import { useTask } from '../task';

export default function SettingsPage({ project, replace }: PageProps) {
  const [msg, setMsg] = useState('');
  const task = useTask();

  function backup() {
    const name = `territory-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
    download(name, JSON.stringify(project), 'application/json');
  }

  async function restore(f: File | undefined) {
    if (!f) return;
    const data = await task.run('Reading the backup', async () => {
      const d = JSON.parse(await f.text()) as Project;
      if (d.version !== 1 || !Array.isArray(d.territories)) throw new Error('This is not a Territory Manager backup');
      return d;
    });
    if (!data) return;
    try {
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
