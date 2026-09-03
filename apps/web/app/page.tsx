import { Editor } from './editor';

export default function HomePage() {
  return (
    <main>
      <h1>Idem</h1>
      <p>
        A collaborative plain-text editor built on a hand-written RGA CRDT. Open this page in two
        tabs — edits sync live over WebSocket.
      </p>
      <Editor />
    </main>
  );
}
