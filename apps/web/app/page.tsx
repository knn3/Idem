import { Editor } from './editor';

export default function HomePage() {
  return (
    <main>
      <h1>Idem</h1>
      <p>
        A collaborative plain-text editor built on a hand-written RGA CRDT. Single-client for now —
        live sync arrives in M6.
      </p>
      <Editor />
    </main>
  );
}
