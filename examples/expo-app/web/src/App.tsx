import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { type Item, type User, addItem, currentUser, listItems, signIn, signOut } from './api';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SignIn({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    signIn(email, password).then(onSignedIn, (failure: unknown) => {
      setError(message(failure));
      setBusy(false);
    });
  };

  return (
    <main className="panel narrow">
      <h1>Sign in</h1>
      <form data-testid="signin-form" onSubmit={submit}>
        <label>
          Email
          <input
            data-testid="signin-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={event => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            data-testid="signin-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p data-testid="signin-error" role="alert" className="error">
            {error}
          </p>
        )}
        <button data-testid="signin-submit" type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
    </main>
  );
}

function AddPlace({ onAdded }: { onAdded: (item: Item) => void }) {
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    addItem(name, Number(minutes)).then(
      item => {
        setName('');
        onAdded(item);
      },
      (failure: unknown) => setError(message(failure)),
    );
  };

  return (
    <form data-testid="add-form" className="add" onSubmit={submit}>
      <label>
        Place
        <input data-testid="add-name" required maxLength={80} value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label>
        Minutes
        <input
          data-testid="add-minutes"
          type="number"
          min={1}
          max={600}
          required
          value={minutes}
          onChange={event => setMinutes(event.target.value)}
        />
      </label>
      <button data-testid="add-submit" type="submit">
        Add place
      </button>
      {error && (
        <p data-testid="add-error" role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

function Places({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [places, setPlaces] = useState<{ items: Item[]; port: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shortestFirst, setShortestFirst] = useState(false);

  const load = useCallback(() => {
    listItems().then(setPlaces, (failure: unknown) => setError(message(failure)));
  }, []);
  useEffect(load, [load]);
  const shown = places && shortestFirst ? [...places.items].sort((a, b) => a.minutes - b.minutes) : places?.items;

  return (
    <main className="panel">
      <header>
        <p data-testid="signed-in-as">
          Signed in as <strong>{user.name}</strong> ({user.email})
        </p>
        <button data-testid="signout" type="button" className="secondary" onClick={() => void signOut().then(onSignedOut)}>
          Sign out
        </button>
      </header>
      <h1>Places</h1>
      {error && (
        <p data-testid="places-error" role="alert" className="error">
          Could not reach the API: {error}
        </p>
      )}
      {places && (
        <>
          <div className="toolbar">
            <p data-testid="served-by" className="muted">
              Served by port {places.port}
            </p>
            <button
              data-testid="sort-shortest"
              type="button"
              className="secondary"
              aria-pressed={shortestFirst}
              onClick={() => setShortestFirst(value => !value)}
            >
              Shortest first
            </button>
          </div>
          <ul data-testid="places" aria-label="Places">
            {shown?.map(item => (
              <li key={item.id} data-testid={`place-${item.id}`}>
                <span>{item.name}</span>
                <span className="muted">{item.minutes} min</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <AddPlace onAdded={load} />
    </main>
  );
}

type Session =
  { kind: 'checking' } | { kind: 'signed-out' } | { kind: 'signed-in'; user: User } | { kind: 'error'; message: string };

export function App() {
  const [session, setSession] = useState<Session>({ kind: 'checking' });

  useEffect(() => {
    currentUser().then(
      user => setSession(user ? { kind: 'signed-in', user } : { kind: 'signed-out' }),
      (failure: unknown) => setSession({ kind: 'error', message: message(failure) }),
    );
  }, []);

  switch (session.kind) {
    case 'checking':
      return <p className="muted">Loading…</p>;
    case 'error':
      return (
        <p data-testid="session-error" role="alert" className="error">
          Could not reach the API: {session.message}
        </p>
      );
    case 'signed-out':
      return <SignIn onSignedIn={user => setSession({ kind: 'signed-in', user })} />;
    case 'signed-in':
      return <Places user={session.user} onSignedOut={() => setSession({ kind: 'signed-out' })} />;
  }
}
