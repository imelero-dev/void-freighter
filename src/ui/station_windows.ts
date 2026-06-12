// Station service windows: market, contracts board + journal, shipyard,
// refinery, cargo hold. All rebuilt from world state on refresh().

import { AMMO_PRICE, GOODS, HULLS, MODULE_NAMES, MODULE_TIER_TAGS, REFINE_RECIPES, modulePrice, MODULE_SELL_FACTOR, shipStats, FUEL_PRICE, REPAIR_PRICE, MISSILE_PRICE } from '../sim/data';
import { ContractBoards } from '../sim/contracts';
import type { Contract, HullId, ModuleSlot } from '../sim/types';
import type { IWorld } from '../world_api';
import { button, clearChildren, el, fmtCredits, fmtDistance, fmtTime } from './dom';
import { goodIcon, moduleIcon } from './icons';
import { keeperFor, type KeeperRole } from './portraits';
import type { StationDef } from '../sim/types';
import type { WindowManager } from './windows';

const ALL_SLOTS: ModuleSlot[] = [
  'engine', 'gyro', 'shield', 'armor', 'cargo', 'weapon', 'missile',
  'drill', 'collector', 'scanner', 'fueltank', 'nav',
];

export class StationUi {
  private dockBar: HTMLElement;

  constructor(private world: IWorld, private wm: WindowManager, private audio: { click(): void; deny(): void; kaching(): void }) {
    this.dockBar = el('div', 'vf-dockbar');
    this.dockBar.style.display = 'none';
    document.body.appendChild(this.dockBar);
    this.buildMarket();
    this.buildContracts();
    this.buildJournal();
    this.buildShipyard();
    this.buildRefinery();
    this.buildCargo();
  }

  // Docked services bar (top of screen while docked)
  updateDockBar(): void {
    const st = this.world.dockedStation;
    if (!st) {
      this.dockBar.style.display = 'none';
      return;
    }
    if (this.dockBar.style.display === 'none') {
      this.dockBar.style.display = 'flex';
      clearChildren(this.dockBar);
      const faction = this.world.system.factions.find((f) => f.id === st.factionId);
      const rep = Math.round(this.world.profile.reputation[st.factionId] ?? 0);
      this.dockBar.appendChild(el('span', 'vf-dock-name', `⚓ ${st.name}`));
      this.dockBar.appendChild(el('span', 'vf-dock-sub', `${faction?.name ?? ''} · rep ${rep >= 0 ? '+' : ''}${rep}${st.blackMarket ? ' · BLACK MARKET' : ''}`));
      const mk = (label: string, id: string, enabled: boolean) => {
        const b = button(label, 'vf-btn', () => {
          this.audio.click();
          this.wm.toggle(id);
          b.classList.toggle('active', this.wm.isOpen(id));
        });
        b.dataset.win = id;
        if (!enabled) b.disabled = true;
        this.dockBar.appendChild(b);
      };
      mk('Market [K]', 'market', st.services.includes('market'));
      mk('Contracts', 'contracts', st.services.includes('contracts'));
      mk('Shipyard', 'shipyard', st.services.includes('shipyard'));
      mk('Refinery', 'refinery', st.services.includes('refinery'));
      mk('Cargo [B]', 'cargo', true);
      mk('Journal [J]', 'journal', true);
      this.dockBar.appendChild(button('UNDOCK [Space]', 'vf-btn undock', () => {
        this.wm.closeAll();
        this.world.undock();
      }));
    }
    // keep active highlights in sync (windows also close via Esc)
    for (const b of this.dockBar.querySelectorAll<HTMLButtonElement>('button[data-win]')) {
      b.classList.toggle('active', this.wm.isOpen(b.dataset.win!));
    }
  }

  hideDockBar(): void {
    this.dockBar.style.display = 'none';
    clearChildren(this.dockBar);
  }

  // Resupply buttons shared by the shipyard and cargo windows.
  private servicesRow(onDone: () => void): HTMLElement {
    const services = el('div', 'vf-services');
    const ship = this.world.player;
    const st = this.world.dockedStation;
    const prof = this.world.profile;
    const stats = this.world.shipStats;
    const act = (label: string, enabled: boolean, fn: () => void) => {
      const b = button(label, 'vf-btn', () => {
        this.audio.click();
        fn();
        setTimeout(onDone, 80);
      });
      if (!enabled) b.disabled = true;
      services.appendChild(b);
    };
    if (ship) {
      const missingHull = Math.ceil(ship.maxHull - ship.hull);
      act(`REPAIR (${missingHull > 0 ? fmtCredits(Math.ceil(missingHull * REPAIR_PRICE)) : 'ok'})`, missingHull > 0, () => this.world.repairHull());
      const missingFuel = Math.ceil(stats.fuelMax - prof.fuel);
      const fuelOk = !!st?.services.includes('fuel');
      act(`REFUEL (${missingFuel > 0 ? fmtCredits(missingFuel * FUEL_PRICE) : 'full'})`, fuelOk && missingFuel > 0, () => this.world.refuel());
      if (stats.cannonAmmoMax > 0) {
        const missingAmmo = stats.cannonAmmoMax - ship.cannonAmmo;
        act(`CANNON AMMO (${missingAmmo > 0 ? fmtCredits(Math.ceil(missingAmmo * AMMO_PRICE)) : 'full'})`, missingAmmo > 0, () => this.world.restockCannonAmmo());
      }
      if (stats.missileAmmoMax > 0) {
        const missingMsl = stats.missileAmmoMax - ship.missileAmmo;
        act(`MISSILES (${missingMsl > 0 ? fmtCredits(missingMsl * MISSILE_PRICE) : 'full'})`, missingMsl > 0, () => this.world.restockMissiles());
      }
    }
    return services;
  }

  // Shopkeeper header card: portrait + name + greeting, per station + role.
  private keeperCard(st: StationDef, role: KeeperRole): HTMLElement {
    const k = keeperFor(st, role);
    const card = el('div', 'vf-keeper');
    const img = document.createElement('img');
    img.src = k.img;
    img.className = 'vf-keeper-img';
    card.appendChild(img);
    const info = el('div', 'vf-keeper-info');
    info.appendChild(el('div', 'vf-keeper-name', k.name));
    info.appendChild(el('div', 'vf-keeper-role', `${k.role} — ${st.name}`));
    info.appendChild(el('div', 'vf-keeper-line', `“${k.line}”`));
    card.appendChild(info);
    return card;
  }

  // -------------------------------------------------------------------------

  private buildMarket(): void {
    const win = this.wm.register('market', 'MARKET', true);
    win.refresh = () => {
      clearChildren(win.body);
      const st = this.world.dockedStation;
      if (!st) {
        win.body.appendChild(el('div', 'vf-empty', 'Dock at a station to trade.'));
        return;
      }
      this.wm.setTitle('market', `MARKET — ${st.name.toUpperCase()}`);
      const market = this.world.market(st.id);
      if (!market) {
        win.body.appendChild(el('div', 'vf-empty', 'No market data.'));
        return;
      }
      win.body.appendChild(this.keeperCard(st, 'quartermaster'));
      const credits = el('div', 'vf-credits', fmtCredits(this.world.profile.credits));
      win.body.appendChild(credits);
      const cargoFree = this.cargoFree();
      win.body.appendChild(el('div', 'vf-subline', `Hold: ${(this.world.shipStats.cargoCapacity - cargoFree).toFixed(0)}/${this.world.shipStats.cargoCapacity} m³`));

      const table = el('div', 'vf-table market-grid');
      const header = el('div', 'vf-row vf-header');
      for (const h of ['', 'COMMODITY', 'BUY', 'SELL', 'STOCK', 'HELD', 'BEST KNOWN', '']) {
        header.appendChild(el('span', 'vf-cell', h));
      }
      table.appendChild(header);

      for (const entry of market) {
        const def = GOODS[entry.good];
        const row = el('div', 'vf-row');
        const ic = el('span', 'vf-cell icon');
        const img = document.createElement('img');
        img.src = goodIcon(entry.good);
        ic.appendChild(img);
        row.appendChild(ic);
        const nm = el('span', 'vf-cell name', def.name);
        if (!def.legal) nm.classList.add('illegal');
        nm.title = `${def.category} · ${def.volume} m³/unit`;
        row.appendChild(nm);
        row.appendChild(el('span', 'vf-cell num', String(entry.buyPrice)));
        row.appendChild(el('span', 'vf-cell num', String(entry.sellPrice)));
        row.appendChild(el('span', 'vf-cell num', String(entry.stock)));
        const held = this.heldQty(entry.good);
        row.appendChild(el('span', 'vf-cell num', held > 0 ? String(held) : '—'));
        row.appendChild(el('span', 'vf-cell best', this.bestKnown(entry.good, st.id)));
        const actions = el('span', 'vf-cell actions');
        const buyN = (n: number) => {
          this.audio.click();
          this.world.buyGood(entry.good, n);
          setTimeout(() => win.refresh(), 60);
        };
        const sellN = (n: number) => {
          this.audio.click();
          this.world.sellGood(entry.good, n);
          setTimeout(() => win.refresh(), 60);
        };
        const maxBuy = Math.max(0, Math.min(
          entry.stock,
          Math.floor(cargoFree / def.volume),
          Math.floor(this.world.profile.credits / Math.max(1, entry.buyPrice)),
        ));
        actions.appendChild(el('span', 'vf-act-label', 'BUY'));
        actions.appendChild(button('1', 'vf-mini', () => buyN(1)));
        actions.appendChild(button('10', 'vf-mini', () => buyN(10)));
        actions.appendChild(button('max', 'vf-mini', () => maxBuy > 0 && buyN(maxBuy)));
        actions.appendChild(el('span', 'vf-act-label sell', 'SELL'));
        const s1 = button('1', 'vf-mini sell', () => sellN(1));
        const s10 = button('10', 'vf-mini sell', () => sellN(10));
        const sAll = button('all', 'vf-mini sell', () => held > 0 && sellN(held));
        if (held <= 0) {
          s1.disabled = true;
          s10.disabled = true;
          sAll.disabled = true;
        }
        actions.appendChild(s1);
        actions.appendChild(s10);
        actions.appendChild(sAll);
        row.appendChild(actions);
        table.appendChild(row);
      }
      win.body.appendChild(table);

      if (this.world.newsLog.length > 0) {
        const news = el('div', 'vf-news');
        news.appendChild(el('div', 'vf-news-title', '— STATION FEED —'));
        for (const line of this.world.newsLog.slice(0, 5)) news.appendChild(el('div', 'vf-news-line', `▸ ${line}`));
        win.body.appendChild(news);
      }
    };
  }

  private heldQty(goodId: string): number {
    return this.world.profile.cargo.filter((c) => c.good === goodId && !c.contractId).reduce((s, c) => s + c.qty, 0);
  }

  private cargoFree(): number {
    let used = 0;
    for (const c of this.world.profile.cargo) used += GOODS[c.good].volume * c.qty;
    return this.world.shipStats.cargoCapacity - used;
  }

  // best known sell price among visited stations (excluding here)
  private bestKnown(goodId: string, hereId: string): string {
    let best = 0;
    let where = '';
    for (const stId of this.world.profile.knownStations) {
      if (stId === hereId) continue;
      const m = this.world.market(stId);
      const entry = m?.find((x) => x.good === goodId);
      if (entry && entry.sellPrice > best) {
        best = entry.sellPrice;
        where = this.world.system.stations.find((s) => s.id === stId)?.name ?? stId;
      }
    }
    return best > 0 ? `${best} @ ${where}` : '—';
  }

  // -------------------------------------------------------------------------

  private buildContracts(): void {
    const win = this.wm.register('contracts', 'CONTRACT BOARD', true);
    win.refresh = () => {
      clearChildren(win.body);
      const st = this.world.dockedStation;
      if (!st) {
        win.body.appendChild(el('div', 'vf-empty', 'Dock to view the local board.'));
        return;
      }
      this.wm.setTitle('contracts', `CONTRACT BOARD — ${st.name.toUpperCase()}`);
      win.body.appendChild(this.keeperCard(st, 'broker'));
      const board = this.world.board(st.id);
      if (board.length === 0) {
        win.body.appendChild(el('div', 'vf-empty', 'No contracts available. The board refreshes every few minutes.'));
      }
      for (const c of board) {
        win.body.appendChild(this.contractCard(c, st.factionId, true));
      }
    };
  }

  private buildJournal(): void {
    const win = this.wm.register('journal', 'CONTRACT JOURNAL');
    win.refresh = () => {
      clearChildren(win.body);
      const contracts = this.world.profile.contracts;
      if (contracts.length === 0) {
        win.body.appendChild(el('div', 'vf-empty', 'No active contracts.'));
      }
      for (const c of contracts) {
        win.body.appendChild(this.contractCard(c, c.factionId, false));
      }
      // stats footer
      const s = this.world.profile.stats;
      const foot = el('div', 'vf-stats',
        `kills ${s.kills} · contracts ${s.contractsDone} · mined ${s.unitsMined}u · traded ${s.unitsTraded}u · deaths ${s.deaths} · earned ${fmtCredits(s.creditsEarned)}`);
      win.body.appendChild(foot);
      const reps = el('div', 'vf-stats');
      const repLine = this.world.system.factions
        .map((f) => `${f.name}: ${Math.round(this.world.profile.reputation[f.id] ?? 0)}`)
        .join(' · ');
      reps.textContent = repLine;
      win.body.appendChild(reps);
    };
  }

  private contractCard(c: Contract, factionId: string, onBoard: boolean): HTMLElement {
    const card = el('div', 'vf-contract');
    const tag = el('span', `vf-ctype ${c.type}`, c.type.toUpperCase());
    card.appendChild(tag);
    card.appendChild(el('span', 'vf-cdesc', c.desc));
    const remaining = c.deadline - this.world.time;
    const detail = el('div', 'vf-cdetail');
    detail.appendChild(el('span', '', `Reward ${fmtCredits(c.reward)} · rep +${c.repReward}`));
    detail.appendChild(el('span', remaining < 240 ? 'urgent' : '', ` · ${fmtTime(remaining)} left`));
    if (c.type === 'bounty') detail.appendChild(el('span', '', ` · ${c.killsDone}/${c.killsRequired} kills`));
    card.appendChild(detail);
    if (onBoard) {
      const repNeed = ContractBoards.repRequired(c);
      const myRep = this.world.profile.reputation[factionId] ?? 0;
      if (myRep < repNeed) {
        card.appendChild(el('div', 'vf-locked', `Requires faction rep ≥ ${repNeed}`));
      } else {
        card.appendChild(button('ACCEPT', 'vf-btn accept', () => {
          this.audio.click();
          this.world.acceptContract(c.id);
          setTimeout(() => this.wm.refreshOpen(), 80);
        }));
      }
    } else {
      if (c.type === 'supply' && this.world.dockedStation?.id === c.dest) {
        card.appendChild(button('DELIVER', 'vf-btn accept', () => {
          this.audio.click();
          this.world.deliverSupply(c.id);
          setTimeout(() => this.wm.refreshOpen(), 80);
        }));
      }
      card.appendChild(button('ABANDON', 'vf-btn danger', () => {
        this.audio.deny();
        this.world.abandonContract(c.id);
        setTimeout(() => this.wm.refreshOpen(), 80);
      }));
    }
    return card;
  }

  // -------------------------------------------------------------------------

  private buildShipyard(): void {
    const win = this.wm.register('shipyard', 'SHIPYARD', true);
    win.refresh = () => {
      clearChildren(win.body);
      const st = this.world.dockedStation;
      const prof = this.world.profile;
      if (!st || !st.services.includes('shipyard')) {
        // read-only ship sheet (C key in flight)
        this.wm.setTitle('shipyard', `SHIP — ${HULLS[prof.hullId].name.toUpperCase()}`);
        const s = shipStats(prof.hullId, prof.modules);
        win.body.appendChild(el('div', 'vf-subline', HULLS[prof.hullId].description));
        for (const slot of ALL_SLOTS) {
          const cur = prof.modules[slot] ?? 0;
          if (cur === 0 && HULLS[prof.hullId].slots[slot] === 0) continue;
          const row = el('div', 'vf-mod-row');
          const ic = document.createElement('img');
          ic.src = moduleIcon(slot);
          ic.className = 'vf-mod-icon';
          row.appendChild(ic);
          row.appendChild(el('span', 'vf-mod-name', `${MODULE_NAMES[slot]} ${cur > 0 ? MODULE_TIER_TAGS[cur] : '(none)'}`));
          row.appendChild(el('span', 'vf-hull-stats', `max ${MODULE_TIER_TAGS[HULLS[prof.hullId].slots[slot]] || '—'}`));
          win.body.appendChild(row);
        }
        win.body.appendChild(el('div', 'vf-stats',
          `speed ${Math.round(s.maxSpeed)} m/s · cruise ${Math.round(s.cruiseMax / 1000)} km/s · hull ${s.maxHull} · shield ${s.maxShield} ` +
          `· cargo ${s.cargoCapacity} m³ · dps ${s.weaponDamage > 0 ? Math.round(s.weaponDamage / s.weaponInterval) : 0} · drill ${s.drillRate.toFixed(1)} u/s · sensor ${fmtDistance(s.sensorRange)}`));
        win.body.appendChild(el('div', 'vf-empty', 'Dock at a station with a shipyard to buy hulls and modules.'));
        return;
      }
      this.wm.setTitle('shipyard', `SHIPYARD — ${st.name.toUpperCase()}`);
      win.body.appendChild(this.keeperCard(st, 'dockmaster'));
      win.body.appendChild(el('div', 'vf-credits', fmtCredits(prof.credits)));

      // services row
      win.body.appendChild(this.servicesRow(() => win.refresh()));

      // hulls
      const hullsBox = el('div', 'vf-section');
      hullsBox.appendChild(el('div', 'vf-section-title', '— HULLS —'));
      for (const hull of Object.values(HULLS)) {
        const row = el('div', 'vf-hull-row');
        const owned = prof.hullId === hull.id;
        row.appendChild(el('span', 'vf-hull-name', `${hull.name} (${hull.id})`));
        row.appendChild(el('span', 'vf-hull-desc', hull.description));
        row.appendChild(el('span', 'vf-hull-stats',
          `cargo ${hull.baseCargo}m³ · hull ${hull.baseHull} · shd ${hull.baseShield} · ${hull.maxSpeed}m/s`));
        if (owned) {
          row.appendChild(el('span', 'vf-owned', 'YOUR SHIP'));
        } else {
          const tradeIn = Math.round(HULLS[prof.hullId].price * 0.7);
          const cost = hull.price - tradeIn;
          row.appendChild(button(`BUY (${fmtCredits(Math.max(0, cost))})`, 'vf-btn', () => {
            this.audio.click();
            this.world.buyHull(hull.id as HullId);
            setTimeout(() => win.refresh(), 80);
          }));
        }
        hullsBox.appendChild(row);
      }
      win.body.appendChild(hullsBox);

      // modules paperdoll
      const modBox = el('div', 'vf-section');
      modBox.appendChild(el('div', 'vf-section-title', '— MODULES —'));
      const hullDef = HULLS[prof.hullId];
      for (const slot of ALL_SLOTS) {
        const maxTier = hullDef.slots[slot];
        if (maxTier === 0) continue;
        const cur = prof.modules[slot] ?? 0;
        const row = el('div', 'vf-mod-row');
        const ic = document.createElement('img');
        ic.src = moduleIcon(slot);
        ic.className = 'vf-mod-icon';
        row.appendChild(ic);
        row.appendChild(el('span', 'vf-mod-name', `${MODULE_NAMES[slot]} ${cur > 0 ? MODULE_TIER_TAGS[cur] : '(none)'}`));
        const tiers = el('span', 'vf-mod-tiers');
        for (let t = 1; t <= maxTier; t++) {
          if (t === cur) {
            tiers.appendChild(el('span', 'vf-tier current', `Mk${t}`));
            continue;
          }
          const tradeIn = cur > 0 ? Math.round(modulePrice(slot, cur) * MODULE_SELL_FACTOR) : 0;
          const cost = modulePrice(slot, t) - tradeIn;
          const b = button(`Mk${t} ${cost >= 0 ? fmtCredits(cost) : `+${fmtCredits(-cost)}`}`, 'vf-tier', () => {
            this.audio.click();
            this.world.buyModule(slot, t);
            setTimeout(() => win.refresh(), 80);
          });
          tiers.appendChild(b);
        }
        if (cur > 0 && slot !== 'engine' && slot !== 'gyro') {
          tiers.appendChild(button(`sell (${fmtCredits(Math.round(modulePrice(slot, cur) * MODULE_SELL_FACTOR))})`, 'vf-tier sell', () => {
            this.audio.click();
            this.world.sellModule(slot);
            setTimeout(() => win.refresh(), 80);
          }));
        }
        row.appendChild(tiers);
        modBox.appendChild(row);
      }
      win.body.appendChild(modBox);

      // module stash (loot)
      if (prof.moduleStash.length > 0) {
        const stashBox = el('div', 'vf-section');
        stashBox.appendChild(el('div', 'vf-section-title', '— SALVAGED MODULES —'));
        prof.moduleStash.forEach((m, i) => {
          const row = el('div', 'vf-mod-row');
          const ic = document.createElement('img');
          ic.src = moduleIcon(m.slot);
          ic.className = 'vf-mod-icon';
          row.appendChild(ic);
          row.appendChild(el('span', 'vf-mod-name', `${MODULE_NAMES[m.slot]} ${MODULE_TIER_TAGS[m.tier]}`));
          const acts = el('span', 'vf-mod-tiers');
          acts.appendChild(button('INSTALL', 'vf-tier', () => {
            this.audio.click();
            this.world.installStashModule(i);
            setTimeout(() => win.refresh(), 80);
          }));
          acts.appendChild(button(`SELL (${fmtCredits(Math.round(modulePrice(m.slot, m.tier) * MODULE_SELL_FACTOR))})`, 'vf-tier sell', () => {
            this.audio.kaching();
            this.world.sellStashModule(i);
            setTimeout(() => win.refresh(), 80);
          }));
          row.appendChild(acts);
          stashBox.appendChild(row);
        });
        win.body.appendChild(stashBox);
      }

      // derived stats summary
      const s = shipStats(prof.hullId, prof.modules);
      win.body.appendChild(el('div', 'vf-stats',
        `speed ${Math.round(s.maxSpeed)} m/s · cruise ${Math.round(s.cruiseMax / 1000)} km/s · hull ${s.maxHull} · shield ${s.maxShield} ` +
        `· cargo ${s.cargoCapacity} m³ · dps ${s.weaponDamage > 0 ? Math.round(s.weaponDamage / s.weaponInterval) : 0} · drill ${s.drillRate.toFixed(1)} u/s · sensor ${fmtDistance(s.sensorRange)}`));
    };
  }

  // -------------------------------------------------------------------------

  private buildRefinery(): void {
    const win = this.wm.register('refinery', 'REFINERY');
    win.refresh = () => {
      clearChildren(win.body);
      const st = this.world.dockedStation;
      if (!st || !st.services.includes('refinery') || st.refineryEff <= 0) {
        win.body.appendChild(el('div', 'vf-empty', 'No refinery at this station.'));
        return;
      }
      this.wm.setTitle('refinery', `REFINERY — ${st.name.toUpperCase()} (eff ${Math.round(st.refineryEff * 100)}%)`);
      win.body.appendChild(this.keeperCard(st, 'foreman'));
      let any = false;
      for (const r of REFINE_RECIPES) {
        const have = this.heldQty(r.input);
        if (have <= 0) continue;
        any = true;
        const out = Math.floor((have / r.ratio) * st.refineryEff);
        const row = el('div', 'vf-row refine');
        const icIn = document.createElement('img');
        icIn.src = goodIcon(r.input);
        row.appendChild(icIn);
        row.appendChild(el('span', 'vf-cell', `${have}× ${GOODS[r.input].name}`));
        row.appendChild(el('span', 'vf-cell arrow', '⟶'));
        const icOut = document.createElement('img');
        icOut.src = goodIcon(r.output);
        row.appendChild(icOut);
        row.appendChild(el('span', 'vf-cell', `${out}× ${GOODS[r.output].name} (fee ${fmtCredits(out * r.fee)})`));
        const b = button('REFINE ALL', 'vf-btn', () => {
          this.audio.click();
          this.world.refine(r.input, have);
          setTimeout(() => win.refresh(), 80);
        });
        if (out <= 0) b.disabled = true;
        row.appendChild(b);
        win.body.appendChild(row);
      }
      if (!any) win.body.appendChild(el('div', 'vf-empty', 'No raw ore in your hold. Mine some rocks first.'));
    };
  }

  // -------------------------------------------------------------------------

  private buildCargo(): void {
    const win = this.wm.register('cargo', 'CARGO HOLD');
    win.refresh = () => {
      clearChildren(win.body);
      const prof = this.world.profile;
      const used = prof.cargo.reduce((s, c) => s + GOODS[c.good].volume * c.qty, 0);
      win.body.appendChild(el('div', 'vf-subline', `${used.toFixed(1)} / ${this.world.shipStats.cargoCapacity} m³ · fuel ${prof.fuel.toFixed(0)}/${this.world.shipStats.fuelMax}`));
      if (this.world.dockedStation) win.body.appendChild(this.servicesRow(() => win.refresh()));
      if (prof.cargo.length === 0) {
        win.body.appendChild(el('div', 'vf-empty', 'Hold is empty.'));
      }
      for (const c of prof.cargo) {
        const def = GOODS[c.good];
        const row = el('div', 'vf-row');
        const img = document.createElement('img');
        img.src = goodIcon(c.good);
        row.appendChild(img);
        const nm = el('span', 'vf-cell name', `${c.qty}× ${def.name}`);
        if (c.contractId) {
          nm.classList.add('sealed');
          nm.title = 'Sealed contract cargo';
          nm.textContent += ' [SEALED]';
        }
        if (!def.legal) nm.classList.add('illegal');
        row.appendChild(nm);
        row.appendChild(el('span', 'vf-cell num', `${(def.volume * c.qty).toFixed(1)} m³`));
        if (c.good === 'fuel_cells' && !c.contractId) {
          row.appendChild(button('USE → FUEL (+8 ea)', 'vf-mini', () => {
            this.audio.click();
            this.world.useFuelCells(Math.min(c.qty, 5));
            setTimeout(() => win.refresh(), 80);
          }));
        }
        win.body.appendChild(row);
      }
      if (prof.moduleStash.length > 0) {
        win.body.appendChild(el('div', 'vf-subline', `Salvaged modules: ${prof.moduleStash.map((m) => `${MODULE_NAMES[m.slot]} ${MODULE_TIER_TAGS[m.tier]}`).join(', ')} (install at a shipyard)`));
      }
    };
  }
}
