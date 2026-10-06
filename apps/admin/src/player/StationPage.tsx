import { Navigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { Player } from './Player';
import type { Station } from './useRadio';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The permanent address of one station: /<uuid>. Plays only that station (the picker is gone and no other station is reachable). */
export function StationPage() {
  const t = useT();
  const { publicId = '' } = useParams();
  const stations = useAsync(() => (UUID.test(publicId) ? api<Station[]>('/radio/stations') : Promise.resolve(null)), [publicId], 10_000);
  if (!UUID.test(publicId)) return <Navigate to="/" replace />;
  const station = stations.data?.find((s) => s.publicId?.toLowerCase() === publicId.toLowerCase());
  if (station) return <Player key={station.slug} lockedSlug={station.slug} />;
  return (
    <main className="pl" style={{ display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}>
      <p className="pl-muted" role={stations.data ? 'alert' : 'status'}>
        {stations.data ? t('player.stationNotFound') : '…'}
      </p>
    </main>
  );
}

