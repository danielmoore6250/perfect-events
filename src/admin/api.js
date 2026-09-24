// Calls to the admin routes. Every request carries the Cognito ID token; a 401
// means the session is gone and the screen should fall back to the login.

import { API_BASE } from '../config';
import { getIdToken, clearSession } from './auth';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const call = async (method, path, body) => {
  const token = await getIdToken();
  if (!token) throw new ApiError(401, 'Signed out');

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }
  if (!res.ok) {
    throw new ApiError(res.status, data.error || data.message || `Request failed (${res.status})`);
  }
  return data;
};

export const listBookings = async () => (await call('GET', '/admin/bookings')).bookings;
export const getBooking = async (id) => (await call('GET', `/admin/bookings/${encodeURIComponent(id)}`)).booking;
export const updateBooking = async (id, changes) =>
  (await call('PATCH', `/admin/bookings/${encodeURIComponent(id)}`, changes)).booking;
