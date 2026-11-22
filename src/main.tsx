import { render } from 'preact';
import { installMeasurer } from './editor/fonts.ts';
import { boot } from './editor/store.ts';
import { App } from './ui/App.tsx';
import './styles.css';

installMeasurer();
render(<App />, document.getElementById('app')!);
void boot();

// handle for the browser smoke test (test/e2e) and for poking around in the dev console
void import('./editor/store.ts').then(s => { (window as unknown as { __vs: unknown }).__vs = s; });
