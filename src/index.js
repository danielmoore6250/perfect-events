import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// Three client-side routes: the public site, /admin, and the client planning
// page at /plan/<token>. CloudFront serves index.html for unknown paths, so a
// direct visit to either lands here too.
const path = window.location.pathname;
const Page = /^\/admin(\/|$)/.test(path)
  ? React.lazy(() => import('./admin/AdminApp'))
  : /^\/plan(\/|$)/.test(path)
    ? React.lazy(() => import('./plan/PlanApp'))
    : null;

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    {Page ? (
      <React.Suspense fallback={null}>
        <Page />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
