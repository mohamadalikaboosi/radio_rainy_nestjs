import { Fragment, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Card, ErrorBox, Pager } from '../ui';

interface Row { id: string; at: string; actor: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown }
const PAGE = 30;

export function Audit() {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error } = useAsync(() => api<{ total: number; items: Row[] }>('/admin/audit', { query: { limit: PAGE, offset: (page - 1) * PAGE } }), [page]);
  return (
    <Card title="Audit log">
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Entity</th><th /></tr></thead>
        <tbody>
          {(data?.items ?? []).map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td>{new Date(r.at).toLocaleString()}</td><td>{r.actor}</td><td><code>{r.action}</code></td><td>{r.entityType}{r.entityId ? ` ${r.entityId.slice(0, 8)}` : ''}</td>
                <td><button className="btn btn-small" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Details'}</button></td>
              </tr>
              {open === r.id && (
                <tr><td colSpan={5}><div className="cols"><div><b>Before</b><pre className="pre">{JSON.stringify(r.before, null, 2)}</pre></div><div><b>After</b><pre className="pre">{JSON.stringify(r.after, null, 2)}</pre></div></div></td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {data && <Pager page={page} pageSize={PAGE} total={data.total} onPage={setPage} />}
    </Card>
  );
}
