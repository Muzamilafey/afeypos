import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Locations {
  branches: { _id: string; name: string; code: string; active: boolean; hasServer?: boolean }[];
  warehouses: { _id: string; name: string; code: string; branchId: string; isDefault: boolean }[];
  tills: { _id: string; name: string; code: string; branchId: string; warehouseId: string; active: boolean }[];
}

export function useLocations() {
  return useQuery({ queryKey: ['locations'], queryFn: () => api<{ data: Locations }>('/settings/locations').then((r) => r.data), staleTime: 60_000 });
}

export function useList<T = any>(key: unknown[], path: string, query?: Record<string, unknown>, enabled = true) {
  return useQuery({ queryKey: [...key, query], queryFn: () => api<{ data: T[]; total?: number; page?: number; limit?: number }>(path, { query }), enabled });
}
