import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }
  componentDidCatch(error, info) {
    this.setState({ error, info })
    // also surface to console for capture scripts
    console.error('ErrorBoundary caught', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{padding:20,fontFamily:'monospace',whiteSpace:'pre-wrap'}}>
          <h2>Runtime error</h2>
          <div>{String(this.state.error && this.state.error.message)}</div>
          <pre style={{maxHeight:400,overflow:'auto'}}>{this.state.info && this.state.info.componentStack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
