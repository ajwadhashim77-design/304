import type { CSSProperties } from 'react'

import { SUIT_IS_RED, SUIT_SYMBOL, card } from '../../game/cards'
import type { CardId } from '../../game/types'

interface Props {
  id: CardId
  onClick?: () => void
  disabled?: boolean
  /** Dimmed but still visible — an illegal play, or the face-down trump. */
  muted?: boolean
  facedown?: boolean
  small?: boolean
  /** Lifts the card and adds a gold rim. */
  highlight?: boolean
  /** The declarer's face-down trump, shown to them alone with a gold tag. */
  concealed?: boolean
  style?: CSSProperties
  title?: string
}

export function PlayingCard({
  id,
  onClick,
  disabled,
  muted,
  facedown,
  small,
  highlight,
  concealed,
  style,
  title,
}: Props) {
  if (facedown) {
    return <div className={cls('card card--back', small && 'card--sm')} style={style} aria-hidden />
  }

  const c = card(id)
  const red = SUIT_IS_RED[c.suit]
  const symbol = SUIT_SYMBOL[c.suit]
  const interactive = Boolean(onClick) && !disabled

  return (
    <button
      type="button"
      className={cls(
        'card',
        red ? 'card--red' : 'card--black',
        small && 'card--sm',
        muted && !concealed && 'is-muted',
        concealed && 'is-concealed',
        highlight && 'is-highlight',
        interactive && 'is-playable',
      )}
      style={style}
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      title={title ?? `${c.rank} of ${c.suit}`}
      aria-label={`${c.rank} of ${symbol}${c.value ? `, ${c.value} points` : ''}`}
    >
      <span className="card__corner card__corner--tl">
        <span className="card__rank">{c.rank}</span>
        <span className="card__pip">{symbol}</span>
      </span>
      <span className="card__face">{symbol}</span>
      <span className="card__corner card__corner--br">
        <span className="card__rank">{c.rank}</span>
        <span className="card__pip">{symbol}</span>
      </span>
      {c.value > 0 && <span className="card__value">{c.value}</span>}
      {concealed && <span className="card__tag">Trump</span>}
    </button>
  )
}

function cls(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
