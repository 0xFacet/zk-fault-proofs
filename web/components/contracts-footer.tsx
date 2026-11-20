import { config, TOKEN_SYMBOL, getL1Chain, getL2Chain } from '@/lib/config'

export function ContractsFooter() {
  const l1Chain = getL1Chain()
  const l2Chain = getL2Chain()
  const l1Explorer = l1Chain.blockExplorers?.default.url || 'https://etherscan.io'
  const l2Explorer = l2Chain.blockExplorers?.default.url || 'https://explorer.facet.org'

  const contracts = [
    { name: 'Rollup', address: config.rollupAddress, href: `${l1Explorer}/address/${config.rollupAddress}` },
    { name: 'Bridge', address: config.l1BridgeAddress, href: `${l1Explorer}/address/${config.l1BridgeAddress}` },
    { name: `${TOKEN_SYMBOL} on ${l2Chain.name.replace(/ Mainnet$/, '')}`, address: config.l2BridgeAddress, href: `${l2Explorer}/address/${config.l2BridgeAddress}` },
  ]

  return (
    <footer className="border-t border-line">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 text-sm">
        <dl className="grid sm:grid-cols-[8rem_1fr] gap-x-8 gap-y-1 sm:gap-y-3">
          {contracts.map((c) => (
            <div key={c.name} className="contents">
              <dt className="text-faint pt-2 sm:pt-0">{c.name}</dt>
              <dd>
                <a href={c.href} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-dim hover:text-ink break-all">
                  {c.address}
                </a>
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-faint">
          <span>Facet Blockchain Technologies, LLC © 2026</span>
          <a href="https://facet.org/terms.html" target="_blank" rel="noopener noreferrer" className="text-dim hover:text-ink">
            Terms
          </a>
        </div>
      </div>
    </footer>
  )
}
