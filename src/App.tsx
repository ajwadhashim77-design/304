import { useState } from 'react'

import { GameTable } from './ui/GameTable'
import { OnlineFlow } from './ui/OnlineScreens'
import { SetupScreen } from './ui/SetupScreen'
import { useGame, type TableSetup } from './ui/useGame'

export default function App() {
  const [screen, setScreen] = useState<'setup' | 'online'>('setup')
  const [setup, setSetup] = useState<TableSetup | null>(null)
  // Bumping the key remounts the table, which is the cleanest way to start a
  // fresh match: new seed, new state, nothing carried over by accident.
  const [matchKey, setMatchKey] = useState(0)

  if (screen === 'online') {
    return <OnlineFlow onExit={() => setScreen('setup')} />
  }

  if (!setup) {
    return <SetupScreen onStart={setSetup} onOnline={() => setScreen('online')} />
  }

  return (
    <Table
      key={matchKey}
      setup={setup}
      onNewMatch={() => setMatchKey((k) => k + 1)}
      onQuit={() => setSetup(null)}
    />
  )
}

function Table({
  setup,
  onNewMatch,
  onQuit,
}: {
  setup: TableSetup
  onNewMatch: () => void
  onQuit: () => void
}) {
  const api = useGame(setup)
  return <GameTable api={api} onNewMatch={onNewMatch} onQuit={onQuit} />
}
