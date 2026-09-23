import { useEffect, useState } from 'react'
import init, { greet } from './pkg/cv_engine'
import './App.css'

function App() {
  const [wasmMessage, setWasmMessage] = useState<string>('Loading WASM module...')

  useEffect(() => {
    // Initialize the WebAssembly module
    init().then(() => {
      // Call our Rust function!
      const msg = greet("Stbn")
      setWasmMessage(msg)
    }).catch(err => {
      console.error("WASM init failed:", err)
      setWasmMessage("Failed to load WASM engine")
    })
  }, [])

  return (
    <>
      <h1>Jigsaw Puzzle Solver</h1>
      <h2>Rust + WebAssembly Engine</h2>
      <div className="card">
        <p>Message from Rust: <strong style={{color: '#42b883'}}>{wasmMessage}</strong></p>
      </div>
      <p className="read-the-docs">
        The heavy computer vision math will happen instantly in the browser.
      </p>
    </>
  )
}

export default App
