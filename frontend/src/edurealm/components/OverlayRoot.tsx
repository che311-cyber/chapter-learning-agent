import type { BattleResult } from '../schemas/types'
import { EV, type NodeSelectedPayload } from '../game/EventBus'
import { useActions, useUi } from '../state/gameStore'
import { useEvent } from '../hooks/useEvent'
import { Landing } from './Landing'
import { HUD } from './HUD'
import { MapInfoPanel } from './MapInfoPanel'
import { BattlePanels } from './BattlePanels'
import { ResultPanel } from './ResultPanel'
import { DevMenu } from './DevMenu'
import { JsonModal } from './JsonModal'
import { Toast } from './Toast'

export function OverlayRoot(): React.ReactElement {
  const screen = useUi().screen
  const actions = useActions()

  useEvent<NodeSelectedPayload>(EV.NODE_SELECTED, (p) => actions.selectNode(p.nodeId))
  useEvent(EV.ARRIVED, () => actions.arriveAtBattle())
  useEvent<BattleResult>(EV.BATTLE_OVER, (r) => actions.battleOver(r))

  return (
    <div className="overlay">
      {screen === 'landing' && <Landing />}
      {screen !== 'landing' && <HUD />}
      {screen === 'intro' && <MapInfoPanel />}
      {(screen === 'battle' || screen === 'result') && <BattlePanels />}
      {screen === 'result' && <ResultPanel />}
      <DevMenu />
      <JsonModal />
      <Toast />
    </div>
  )
}
