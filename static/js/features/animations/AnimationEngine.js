// static/js/AnimationEngine.js
// Motor genérico de animações (Mitosis + Morph) reutilizável

import { measureIslandBarMitosis } from '/static/js/features/island/MitosisMetrics.js';

export class AnimationEngine {
  static _mitosisStrategies = new Map();

  /**
   * Prepara o ambiente com estilos CSS de animação
   * @param {string} name - Nome do motor de animação (ex: 'cellular', 'slide', etc)
   * @param {string} keyframeCSS - CSS com @keyframes personalizados
   */
  static registerKeyframes(name, keyframeCSS) {
    const id = `animation-keyframes-${name}`;
    if (document.getElementById(id)) return;

    const style = document.createElement('style');
    style.id = id;
    style.textContent = keyframeCSS;
    document.head.appendChild(style);
  }

  /**
   * Garante um store de timers no host informado
   * @param {Object} owner - Objeto que armazena timers
   * @param {string} property - Nome da propriedade com Set de timers
   * @returns {Set|null}
   */
  static ensureTimerStore(owner, property = 'animationTimers') {
    if (!owner) return null;
    if (!(owner[property] instanceof Set)) {
      owner[property] = new Set();
    }
    return owner[property];
  }

  /**
   * Agenda callback com cleanup automático no store do host
   * @param {Object} owner - Objeto que armazena o Set de timers
   * @param {Function} callback - Função a executar
   * @param {number} delay - Delay em ms
   * @param {string} property - Nome da propriedade com Set de timers
   * @returns {number}
   */
  static schedule(owner, callback, delay = 0, property = 'animationTimers') {
    const timers = this.ensureTimerStore(owner, property);
    const timerId = setTimeout(() => {
      if (timers) timers.delete(timerId);
      callback();
    }, delay);

    if (timers) timers.add(timerId);
    return timerId;
  }

  /**
   * Cancela todos os callbacks agendados de um host
   * @param {Object} owner - Objeto que armazena o Set de timers
   * @param {string} property - Nome da propriedade com Set de timers
   */
  static clearScheduled(owner, property = 'animationTimers') {
    const timers = owner?.[property];
    if (!(timers instanceof Set)) return;

    timers.forEach((timerId) => clearTimeout(timerId));
    timers.clear();
  }

  /**
   * Executa um callback após N requestAnimationFrames
   * @param {Function} callback - Função a executar
   * @param {number} frameCount - Quantidade de frames a aguardar
   */
  static afterFrames(callback, frameCount = 1) {
    if (typeof callback !== 'function') return;

    let remaining = Math.max(1, frameCount);
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        callback();
        return;
      }
      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  }

  /**
   * Aplica uma classe após N requestAnimationFrames para garantir commit de layout
   * @param {HTMLElement} element - Elemento alvo
   * @param {string} className - Classe a aplicar
   * @param {number} frameCount - Quantidade de frames a aguardar
   */
  static applyClassNextFrame(element, className, frameCount = 2) {
    if (!element || !className) return;

    this.afterFrames(() => {
      if (element.classList) {
        element.classList.add(className);
      }
    }, frameCount);
  }

  /**
   * Observa transitionend com fallback via timeout para evitar estados presos
   * @param {Object|null} owner - Host opcional para armazenar o timer de fallback
   * @param {HTMLElement} element - Elemento monitorado
   * @param {Object} options - Configurações
   * @returns {Function} - Finalizador manual
   */
  static afterTransitionOrTimeout(owner, element, options = {}) {
    if (!element || typeof options.callback !== 'function') {
      return () => {};
    }

    const {
      propertyName = null,
      timeoutMs = 0,
      timerProperty = 'animationTimers',
      callback
    } = options;

    let settled = false;
    let timerId = null;

    const cleanup = () => {
      element.removeEventListener('transitionend', onTransitionEnd);
      if (timerId === null) return;

      clearTimeout(timerId);

      const timers = owner?.[timerProperty];
      if (timers instanceof Set) {
        timers.delete(timerId);
      }

      timerId = null;
    };

    const finalize = () => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onTransitionEnd = (event) => {
      if (event.target !== element) return;
      if (propertyName && event.propertyName !== propertyName) return;
      finalize();
    };

    element.addEventListener('transitionend', onTransitionEnd);

    if (timeoutMs > 0) {
      timerId = owner
        ? this.schedule(owner, finalize, timeoutMs, timerProperty)
        : setTimeout(finalize, timeoutMs);
    }

    return finalize;
  }

  /**
   * Cria uma superfície de mitose reutilizável com parent configurável
   * @param {HTMLElement} island - Elemento da ilha
   * @param {Object} options - Configurações
   *   - parent: nó pai onde o elemento será inserido
   *   - insert: 'append' | 'prepend'
   *   - className: classe CSS do elemento
   *   - cssVars: mapa de custom properties
   * @returns {HTMLElement} - Elemento do container criado
   */
  static createMitosis(island, options = {}) {
    const {
      parent = document.body,
      insert = 'append',
      className = '',
      containerHTML = '',
      onComplete = null,
      duration = 0,
      containerId = 'mitosis-container',
      initialStyle = null,
      cssVars = {},
      attributes = {},
      owner = null,
      timerProperty = 'animationTimers',
      useDefaultIslandStyle = true
    } = options;

    const container = document.createElement('div');
    if (containerId) container.id = containerId;
    if (className) container.className = className;
    container.innerHTML = containerHTML;

    Object.entries(attributes).forEach(([name, value]) => {
      if (value === undefined || value === null) return;
      container.setAttribute(name, value);
    });

    if (initialStyle) {
      container.style.cssText = initialStyle;
    } else if (useDefaultIslandStyle) {
      const metrics = measureIslandBarMitosis(island, {
        originTop: 15,
        originWidth: 450,
        originHeight: 38,
        copyGap: 7,
        extraDrop: 22
      });

      container.style.cssText = `
        position: fixed;
        top: ${metrics.originTop}px;
        left: 50%;
        transform: translate(-50%, 0) scale(0);
        width: ${metrics.originWidth}px;
        height: ${metrics.originHeight}px;
        z-index: 996;
        border-radius: var(--radius-dynamic-island);
        pointer-events: auto;
      `;
    }

    Object.entries(cssVars).forEach(([name, value]) => {
      if (value === undefined || value === null) return;
      container.style.setProperty(name, value);
    });

    if (insert === 'prepend' && parent.firstChild) {
      parent.insertBefore(container, parent.firstChild);
    } else {
      parent.appendChild(container);
    }

    if (onComplete) {
      if (owner) {
        this.schedule(owner, () => onComplete(container), duration, timerProperty);
      } else {
        setTimeout(() => onComplete(container), duration);
      }
    }

    return container;
  }

  /**
   * Remove uma superfície de mitose com timeout simples ou transition fallback
   * @param {HTMLElement} container - Elemento a contrair
   * @param {Object} options - Configurações
   *   - owner: host opcional para armazenar timers
   *   - waitForTransition: se deve aguardar transitionend com fallback
   *   - propertyName: propriedade a observar no transitionend
   */
  static destroyMitosis(container, options = {}) {
    if (!container) return;

    const {
      onComplete = null,
      duration = 0,
      owner = null,
      timerProperty = 'animationTimers',
      waitForTransition = false,
      propertyName = null
    } = options;

    const finalize = () => {
      if (container.parentNode) {
        container.remove();
      }
      if (onComplete) onComplete(container);
    };

    if (waitForTransition) {
      return this.afterTransitionOrTimeout(owner, container, {
        propertyName,
        timeoutMs: duration,
        timerProperty,
        callback: finalize
      });
    }

    if (duration <= 0) {
      finalize();
      return finalize;
    }

    if (owner) {
      return this.schedule(owner, finalize, duration, timerProperty);
    }

    return setTimeout(finalize, duration);
  }

  /**
   * Cria uma membrane SVG temporária para desenhar um único contorno/sombra
   * contínuos durante animações de divisão/absorção.
   * @param {Object} options - Configurações da membrane
   * @returns {Object|null} - Controller da membrane
   */
  static createDivisionMembrane(options = {}) {
    return createDivisionMembraneController(options);
  }

  /**
   * Executa uma sequência declarativa de fases para animações compostas
   * @param {Object} owner - Host que armazena timers
   * @param {Array<Object>} steps - Lista de passos sequenciais
   * @param {Object} options - Contexto e configurações auxiliares
   * @returns {Object} - Contexto mutável da sequência
   */
  static runSequence(owner, steps = [], options = {}) {
    const {
      context = {},
      timerProperty = 'animationTimers',
      onComplete = null
    } = options;

    const sequence = Array.isArray(steps) ? steps.filter(Boolean) : [];

    const runStep = (index) => {
      if (index >= sequence.length) {
        if (typeof onComplete === 'function') {
          onComplete(context);
        }
        return;
      }

      const step = sequence[index] || {};

      const continueToNext = () => runStep(index + 1);

      const executeStep = () => {
        if (typeof step.run === 'function') {
          step.run(context);
        }

        if (step.waitForTransition) {
          const transition = step.waitForTransition;
          const element = typeof transition.element === 'function'
            ? transition.element(context)
            : transition.element;

          this.afterTransitionOrTimeout(owner, element, {
            propertyName: transition.propertyName ?? null,
            timeoutMs: transition.timeoutMs ?? 0,
            timerProperty,
            callback: continueToNext
          });
          return;
        }

        const holdMs = Number.isFinite(step.holdMs) ? step.holdMs : 0;
        if (holdMs > 0) {
          this.schedule(owner, continueToNext, holdMs, timerProperty);
          return;
        }

        continueToNext();
      };

      const launchStep = () => {
        const frameCount = Number.isFinite(step.frames) ? step.frames : 0;
        if (frameCount > 0) {
          this.afterFrames(executeStep, frameCount);
          return;
        }

        executeStep();
      };

      const delayMs = Number.isFinite(step.delay) ? step.delay : 0;
      if (delayMs > 0) {
        this.schedule(owner, launchStep, delayMs, timerProperty);
        return;
      }

      launchStep();
    };

    runStep(0);
    return context;
  }

  /**
   * Registra uma estratégia de mitose reutilizável
   * @param {string} name - Nome da estratégia
   * @param {Function} strategy - Handler da estratégia
   */
  static registerMitosisStrategy(name, strategy) {
    if (!name || typeof strategy !== 'function') return;
    this._mitosisStrategies.set(name, strategy);
  }

  /**
   * Executa uma estratégia de mitose previamente registrada
   * @param {string} name - Nome da estratégia
   * @param {Object} context - Contexto de execução
   * @param {Object} options - Opções específicas da estratégia
   * @returns {*}
   */
  static runMitosisStrategy(name, context = {}, options = {}) {
    const strategy = this._mitosisStrategies.get(name);
    if (!strategy) {
      console.warn(`AnimationEngine.runMitosisStrategy: unknown strategy \"${name}\"`);
      return null;
    }

    return strategy({
      engine: this,
      context,
      options
    });
  }

  /**
   * Executa Morph (expansão da ilha para mostrar conteúdo)
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {Object} options - Configurações
   *   - width, height, radius: dimensões finais
   *   - viewId: ID da view a mostrar
   *   - islandClass: classe CSS adicional
   *   - duration: tempo de transição em ms
   */
  static morph(island, options = {}) {
    if (!island || !island.morph) {
      console.warn('AnimationEngine.morph: RolfsoundIsland not properly configured');
      return;
    }
    island.morph(options);
  }

  /**
   * Desfaz Morph (volta a ilha ao estado normal)
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   */
  static reset(island, options = {}) {
    if (!island || !island.reset) {
      console.warn('AnimationEngine.reset: RolfsoundIsland not properly configured');
      return;
    }
    island.reset(options);
  }

  /**
   * Aplica uma resposta elástica vetorial na ilha principal
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {Object} options - { sourceRect, sourceVector, strength, duration }
   */
  static respondToImpact(island, options = {}) {
    if (!island || !island.respondToImpact) {
      console.warn('AnimationEngine.respondToImpact: RolfsoundIsland not properly configured');
      return;
    }
    island.respondToImpact(options);
  }

  /**
   * Mostra notificação temporária na ilha
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {Object} options - { text, spinner, duration }
   */
  static showNotification(island, options = {}) {
    if (!island || !island.showNotification) {
      console.warn('AnimationEngine.showNotification: RolfsoundIsland not properly configured');
      return;
    }
    island.showNotification(options);
  }

  /**
   * Executa mitose de botão (radiação de controle a partir da ilha)
   * Usa a estratégia compartilhada de pill para manter a coreografia consistente
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {Object} options - { id, icon, eventName, direction, distance }
   */
  static mitosis(island, options = {}) {
    if (!island || !island.shadowRoot) {
      console.warn('AnimationEngine.mitosis: RolfsoundIsland not properly configured');
      return;
    }

    const {
      id = 'default',
      icon = '',
      eventName = 'rolfsound-mitosis-click',
      direction = 'right',
      distance = 237,
      onCreate = null
    } = options;

    return this.runMitosisStrategy('division-lite-open', { island }, {
      owner: island,
      containerId: `mitosis-${id}`,
      containerHTML: `
            <div class="mitosis-btn hover-target">
                ${icon}
            </div>
        `,
      cssVars: {
        '--mitosis-distance': `${distance}px`
      },
      direction,
      growDelayMs: 10,
      revealDelayMs: 90,
      settleTimeoutMs: 260,
      onCreate: (pill) => {
        pill.addEventListener('click', (event) => {
          event.stopPropagation();
          island.dispatchEvent(new CustomEvent(eventName, { bubbles: true, composed: true }));
        });

        if (typeof onCreate === 'function') {
          onCreate(pill);
        }
      }
    });
  }

  /**
   * Desfaz mitose de botão (retrai o controle para a ilha)
   * Usa a estratégia compartilhada de recolhimento de pills
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {string} id - ID do botão de mitose a remover
   */
  static undoMitosis(island, idOrOptions = null, maybeOptions = {}) {
    if (!island || !island.shadowRoot) {
      console.warn('AnimationEngine.undoMitosis: RolfsoundIsland not properly configured');
      return;
    }

    const id = typeof idOrOptions === 'string' || idOrOptions === null
      ? idOrOptions
      : null;
    const options = (idOrOptions && typeof idOrOptions === 'object' && !Array.isArray(idOrOptions))
      ? idOrOptions
      : maybeOptions;

    const selector = options.selector || (id ? `#mitosis-${id}` : '.mitosis-pill');
    const pills = Array.isArray(options.pills)
      ? options.pills.filter(Boolean)
      : Array.from(island.shadowRoot.querySelectorAll(selector));

    pills.forEach((pill) => {
      this.runMitosisStrategy('division-lite-close', { island }, {
        owner: island,
        pill,
        absorbDelayMs: 70,
        removalDelay: 600,
        collapseClassName: 'mitosis-pill',
        getImpactOptions: ({ impactRect }) => ({
          sourceRect: impactRect,
          strength: 0.82
        }),
        ...options
      });
    });

    return pills;
  }

  /**
   * Executa mitose full (DivisionAnimator) para cenarios que exigem
   * fisica de divisao/absorcao com membrana SVG.
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {Object} options - Opcoes da divisao full
   * @returns {Promise<Object|null>|Object|null}
   */
  static mitosisFull(island, options = {}) {
    if (!island) {
      console.warn('AnimationEngine.mitosisFull: island is required');
      return null;
    }

    return this.runMitosisStrategy('division-full-open', {
      island,
      owner: options.owner || island
    }, options);
  }

  /**
   * Desfaz mitose full (DivisionAnimator) para cenarios que exigem
   * ciclo reverso completo com absorcao.
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {Object} options - Opcoes de fechamento da divisao full
   * @returns {Promise<Object|null>|Object|null}
   */
  static undoMitosisFull(island, options = {}) {
    if (!island) {
      console.warn('AnimationEngine.undoMitosisFull: island is required');
      return null;
    }

    return this.runMitosisStrategy('division-full-close', {
      island,
      owner: options.owner || island
    }, options);
  }

  /**
   * Atualiza o texto da notificação temporária
   * Delegação para RolfsoundIsland.updateNotificationText() com validação
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {string} text - Novo texto da notificação
   */
  static updateNotificationText(island, text) {
    if (!island || !island.updateNotificationText) {
      console.warn('AnimationEngine.updateNotificationText: RolfsoundIsland not properly configured');
      return;
    }
    island.updateNotificationText(text);
  }

  /**
   * Esconde a notificação temporária
   * Delegação para RolfsoundIsland.hideNotification() com validação
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   */
  static hideNotification(island, options = {}) {
    if (!island || !island.hideNotification) {
      console.warn('AnimationEngine.hideNotification: RolfsoundIsland not properly configured');
      return;
    }
    island.hideNotification(options);
  }
}

let divisionMembraneCounter = 0;

function createDivisionMembraneController(options = {}) {
  const {
    topElement = null,
    bottomElement = null,
    axis = 'vertical',
    fillColor = 'rgba(15, 15, 15, 0.92)',
    strokeColor = 'rgba(255, 255, 255, 0.06)',
    shadowColor = '#000000',
    shadowOpacity = 0.42,
    shadowBlur = 10,
    shadowOffsetY = 8,
    zIndex = 995
  } = options;

  if (!topElement || !bottomElement) return null;

  const namespace = 'http://www.w3.org/2000/svg';
  const membraneId = `division-membrane-${++divisionMembraneCounter}`;
  const shadowFilterId = `${membraneId}-shadow`;

  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', `${window.innerWidth}`);
  svg.setAttribute('height', `${window.innerHeight}`);
  svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  svg.style.cssText = `
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    overflow: visible;
    pointer-events: none;
    z-index: ${zIndex};
    opacity: 1;
  `;

  const defs = document.createElementNS(namespace, 'defs');
  defs.innerHTML = `
    <filter id="${shadowFilterId}" x="-25%" y="-30%" width="150%" height="180%" color-interpolation-filters="sRGB">
      <feComponentTransfer in="SourceAlpha" result="alphaBoost">
        <feFuncA type="linear" slope="80" intercept="0"></feFuncA>
      </feComponentTransfer>
      <feOffset in="alphaBoost" dy="${shadowOffsetY}" result="offset"></feOffset>
      <feGaussianBlur in="offset" stdDeviation="${shadowBlur}" result="blur"></feGaussianBlur>
      <feFlood flood-color="${shadowColor}" flood-opacity="${shadowOpacity}" result="shadowColor"></feFlood>
      <feComposite in="shadowColor" in2="blur" operator="in" result="shadow"></feComposite>
      <feMerge>
        <feMergeNode in="shadow"></feMergeNode>
        <feMergeNode in="SourceGraphic"></feMergeNode>
      </feMerge>
    </filter>
  `;

  const createPath = () => {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('fill', fillColor);
    path.setAttribute('stroke', strokeColor);
    path.setAttribute('stroke-width', '1');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('shape-rendering', 'geometricPrecision');
    path.setAttribute('filter', `url(#${shadowFilterId})`);
    path.style.strokeLinejoin = 'round';
    path.style.strokeLinecap = 'round';
    return path;
  };

  const connectedPath = createPath();
  const topPath = createPath();
  const bottomPath = createPath();

  svg.appendChild(defs);
  svg.appendChild(connectedPath);
  svg.appendChild(topPath);
  svg.appendChild(bottomPath);
  document.body.appendChild(svg);

  let isActive = true;
  let rafId = 0;
  let mode = 'connected';
  let activeTopElement = topElement;
  let activeBottomElement = bottomElement;
  let activeBridgeElement = null;
  let activeNeckWidth = null;
  let activeNeckWidthProvider = null;
  let activeAxis = axis;

  const showConnected = () => {
    connectedPath.style.display = '';
    topPath.style.display = 'none';
    bottomPath.style.display = 'none';
  };

  const showSplit = () => {
    connectedPath.style.display = 'none';
    topPath.style.display = '';
    bottomPath.style.display = '';
  };

  const render = () => {
    if (!isActive) return;

    const topRect = activeTopElement?.getBoundingClientRect();
    const bottomRect = activeBottomElement?.getBoundingClientRect();

    // Guard: need valid rects with positive size on the relevant axis
    const sizeCheck = activeAxis === 'horizontal'
      ? (bottomRect && bottomRect.height > 0)
      : (bottomRect && bottomRect.width > 0);
    if (!topRect || !bottomRect || !sizeCheck) {
      rafId = requestAnimationFrame(render);
      return;
    }

    if (mode === 'connected') {
      const bridgeRect = activeBridgeElement?.isConnected
        ? activeBridgeElement.getBoundingClientRect()
        : null;

      // Default neck dimension: bridge size on the cross-axis, or min of both elements
      const defaultNeck = activeAxis === 'horizontal'
        ? (bridgeRect ? bridgeRect.height : Math.min(topRect.height, bottomRect.height))
        : (bridgeRect ? bridgeRect.width  : Math.min(topRect.width,  bottomRect.width));

      const neckWidth = Number.isFinite(activeNeckWidth)
        ? activeNeckWidth
        : (typeof activeNeckWidthProvider === 'function'
            ? activeNeckWidthProvider({ topRect, bottomRect, bridgeRect })
            : defaultNeck);

      const pathBuilder = activeAxis === 'horizontal'
        ? buildConnectedMembranePathHorizontal
        : buildConnectedMembranePath;

      connectedPath.setAttribute('d', pathBuilder({
        topRect,
        bottomRect,
        topRadius: resolveElementRadius(activeTopElement, 16),
        bottomRadius: resolveElementRadius(activeBottomElement, 16),
        neckWidth
      }));
      showConnected();
    } else {
      topPath.setAttribute('d', buildRoundedRectPath(topRect, resolveElementRadius(activeTopElement, 16)));
      bottomPath.setAttribute('d', buildRoundedRectPath(bottomRect, resolveElementRadius(activeBottomElement, 16)));
      showSplit();
    }

    rafId = requestAnimationFrame(render);
  };

  const start = () => {
    if (rafId) return;
    // Render once immediately to avoid a one-frame visual gap when shell turns translucent.
    render();
  };

  const stop = () => {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  };

  const controller = {
    setConnected(nextOptions = {}) {
      mode = 'connected';
      if (nextOptions.topElement) activeTopElement = nextOptions.topElement;
      if (nextOptions.bottomElement) activeBottomElement = nextOptions.bottomElement;
      activeBridgeElement = nextOptions.bridgeElement ?? activeBridgeElement;
      activeNeckWidth = Number.isFinite(nextOptions.neckWidth) ? nextOptions.neckWidth : null;
      activeNeckWidthProvider = typeof nextOptions.neckWidthProvider === 'function'
        ? nextOptions.neckWidthProvider
        : null;
      start();
    },
    setSplit(nextOptions = {}) {
      mode = 'split';
      if (nextOptions.topElement) activeTopElement = nextOptions.topElement;
      if (nextOptions.bottomElement) activeBottomElement = nextOptions.bottomElement;
      activeBridgeElement = null;
      activeNeckWidth = null;
      activeNeckWidthProvider = null;
      start();
    },
    fadeOut(durationMs = 120, onComplete = null) {
      svg.style.transition = `opacity ${durationMs}ms ease`;
      svg.style.opacity = '0';
      AnimationEngine.afterTransitionOrTimeout(null, svg, {
        propertyName: 'opacity',
        timeoutMs: durationMs,
        callback: () => {
          controller.remove();
          if (typeof onComplete === 'function') onComplete();
        }
      });
    },
    remove() {
      if (!isActive) return;
      isActive = false;
      stop();
      if (svg.parentNode) svg.remove();
    }
  };

  controller.setConnected({
    topElement,
    bottomElement,
    bridgeElement: options.bridgeElement || null,
    neckWidth: options.neckWidth,
    neckWidthProvider: options.neckWidthProvider
  });

  return controller;
}

function buildRoundedRectPath(rect, radius = 16) {
  const x = rect.left;
  const y = rect.top;
  const width = Math.max(0.5, rect.width);
  const height = Math.max(0.5, rect.height);
  const r = clampRadius(radius, width, height);

  return [
    `M ${x + r} ${y}`,
    `H ${x + width - r}`,
    `A ${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V ${y + height - r}`,
    `A ${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + height - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z'
  ].join(' ');
}

function buildConnectedMembranePath({ topRect, bottomRect, topRadius = 16, bottomRadius = 16, neckWidth = 24 }) {
  if (!topRect || !bottomRect || bottomRect.height <= 0.5) {
    return buildRoundedRectPath(topRect, topRadius);
  }

  const topX = topRect.left;
  const topY = topRect.top;
  const topW = Math.max(0.5, topRect.width);
  const topH = Math.max(0.5, topRect.height);
  const bottomX = bottomRect.left;
  const bottomY = Math.max(bottomRect.top, topY + topH);
  const bottomW = Math.max(0.5, bottomRect.width);
  const bottomH = Math.max(0.5, bottomRect.height);

  const topR = clampRadius(topRadius, topW, topH);
  const bottomR = clampRadius(bottomRadius, bottomW, bottomH);

  const topCenterX = topRect.left + (topRect.width / 2);
  const bottomCenterX = bottomRect.left + (bottomRect.width / 2);
  const requestedHalfNeck = Math.max(0.5, neckWidth / 2);
  const topMaxHalfNeck = Math.max(0.5, (topW / 2) - topR);
  const bottomMaxHalfNeck = Math.max(0.5, (bottomW / 2) - bottomR);
  const topHalfNeck = Math.min(requestedHalfNeck, topMaxHalfNeck);
  const bottomHalfNeck = Math.min(requestedHalfNeck, bottomMaxHalfNeck);

  const topLeft = topX;
  const topRight = topX + topW;
  const bottomLeft = bottomX;
  const bottomRight = bottomX + bottomW;
  const topBottomY = topY + topH;
  const neckPhase = resolveMembraneNeckPhase(topHalfNeck, bottomHalfNeck, topMaxHalfNeck, bottomMaxHalfNeck);
  const topInner = resolveMembraneNeckInner(topHalfNeck, neckPhase);
  const bottomInner = resolveMembraneNeckInner(bottomHalfNeck, neckPhase);
  const tension = resolveMembraneCurveTension(bottomY - topBottomY, neckPhase);

  return [
    `M ${topLeft + topR} ${topY}`,
    `H ${topRight - topR}`,
    `A ${topR} ${topR} 0 0 1 ${topRight} ${topY + topR}`,
    `V ${topBottomY - topR}`,
    `A ${topR} ${topR} 0 0 1 ${topRight - topR} ${topBottomY}`,
    `H ${topCenterX + topHalfNeck}`,
    `C ${topCenterX + topInner} ${topBottomY + tension} ${bottomCenterX + bottomInner} ${bottomY - tension} ${bottomCenterX + bottomHalfNeck} ${bottomY}`,
    `H ${bottomRight - bottomR}`,
    `A ${bottomR} ${bottomR} 0 0 1 ${bottomRight} ${bottomY + bottomR}`,
    `V ${bottomY + bottomH - bottomR}`,
    `A ${bottomR} ${bottomR} 0 0 1 ${bottomRight - bottomR} ${bottomY + bottomH}`,
    `H ${bottomLeft + bottomR}`,
    `A ${bottomR} ${bottomR} 0 0 1 ${bottomLeft} ${bottomY + bottomH - bottomR}`,
    `V ${bottomY + bottomR}`,
    `A ${bottomR} ${bottomR} 0 0 1 ${bottomLeft + bottomR} ${bottomY}`,
    `H ${bottomCenterX - bottomHalfNeck}`,
    `C ${bottomCenterX - bottomInner} ${bottomY - tension} ${topCenterX - topInner} ${topBottomY + tension} ${topCenterX - topHalfNeck} ${topBottomY}`,
    `H ${topLeft + topR}`,
    `A ${topR} ${topR} 0 0 1 ${topLeft} ${topBottomY - topR}`,
    `V ${topY + topR}`,
    `A ${topR} ${topR} 0 0 1 ${topLeft + topR} ${topY}`,
    'Z'
  ].join(' ');
}

/**
 * Horizontal membrane path — connects a left element to a right element.
 * "topRect/bottomRect" here = leftRect/rightRect (reuses the membrane
 * controller's naming).  neckWidth is measured along the Y axis (height
 * of the neck between the two elements' adjacent vertical edges).
 */
function buildConnectedMembranePathHorizontal({ topRect: leftRect, bottomRect: rightRect, topRadius: leftRadius = 16, bottomRadius: rightRadius = 16, neckWidth = 24 }) {
  if (!leftRect || !rightRect || rightRect.width <= 0.5) {
    return buildRoundedRectPath(leftRect, leftRadius);
  }

  const lx = leftRect.left;
  const ly = leftRect.top;
  const lw = Math.max(0.5, leftRect.width);
  const lh = Math.max(0.5, leftRect.height);
  const rx = Math.max(rightRect.left, lx + lw);
  const ry = rightRect.top;
  const rw = Math.max(0.5, rightRect.width);
  const rh = Math.max(0.5, rightRect.height);

  const lR = clampRadius(leftRadius, lw, lh);
  const rR = clampRadius(rightRadius, rw, rh);

  const leftCenterY = ly + lh / 2;
  const rightCenterY = ry + rh / 2;
  const requestedHalfNeck = Math.max(0.5, neckWidth / 2);
  const leftMaxHalfNeck = Math.max(0.5, (lh / 2) - lR);
  const rightMaxHalfNeck = Math.max(0.5, (rh / 2) - rR);
  const leftHalfNeck = Math.min(requestedHalfNeck, leftMaxHalfNeck);
  const rightHalfNeck = Math.min(requestedHalfNeck, rightMaxHalfNeck);

  const leftRight = lx + lw;   // right edge of left element
  const rightLeft = rx;          // left edge of right element
  const neckPhase = resolveMembraneNeckPhase(leftHalfNeck, rightHalfNeck, leftMaxHalfNeck, rightMaxHalfNeck);
  const leftInner = resolveMembraneNeckInner(leftHalfNeck, neckPhase);
  const rightInner = resolveMembraneNeckInner(rightHalfNeck, neckPhase);
  const tension = resolveMembraneCurveTension(rightLeft - leftRight, neckPhase);

  // Trace: left top-left corner → clockwise around left → neck → right → back
  return [
    // ── Left element: top-left → top-right ──
    `M ${lx + lR} ${ly}`,
    `H ${leftRight - lR}`,
    `A ${lR} ${lR} 0 0 1 ${leftRight} ${ly + lR}`,
    // Down to neck top on left's right edge
    `V ${leftCenterY - leftHalfNeck}`,
    // ── Neck: cross to right element ──
    `C ${leftRight + tension} ${leftCenterY - leftInner} ${rightLeft - tension} ${rightCenterY - rightInner} ${rightLeft} ${rightCenterY - rightHalfNeck}`,
    // ── Right element: top portion down ──
    `V ${ry + rR}`,
    `A ${rR} ${rR} 0 0 0 ${rightLeft + rR} ${ry}`,
    // Right element: top edge
    `H ${rx + rw - rR}`,
    `A ${rR} ${rR} 0 0 1 ${rx + rw} ${ry + rR}`,
    // Right element: right edge
    `V ${ry + rh - rR}`,
    `A ${rR} ${rR} 0 0 1 ${rx + rw - rR} ${ry + rh}`,
    // Right element: bottom edge
    `H ${rightLeft + rR}`,
    `A ${rR} ${rR} 0 0 0 ${rightLeft} ${ry + rh - rR}`,
    // Down to neck bottom on right's left edge
    `V ${rightCenterY + rightHalfNeck}`,
    // ── Neck: cross back to left element ──
    `C ${rightLeft - tension} ${rightCenterY + rightInner} ${leftRight + tension} ${leftCenterY + leftInner} ${leftRight} ${leftCenterY + leftHalfNeck}`,
    // ── Left element: bottom portion ──
    `V ${ly + lh - lR}`,
    `A ${lR} ${lR} 0 0 1 ${leftRight - lR} ${ly + lh}`,
    // Left element: bottom edge
    `H ${lx + lR}`,
    `A ${lR} ${lR} 0 0 1 ${lx} ${ly + lh - lR}`,
    // Left element: left edge
    `V ${ly + lR}`,
    `A ${lR} ${lR} 0 0 1 ${lx + lR} ${ly}`,
    'Z'
  ].join(' ');
}

function clampRadius(radius, width, height) {
  const nextRadius = Number.isFinite(radius) ? radius : 16;
  return Math.max(0, Math.min(nextRadius, width / 2, height / 2));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function resolveMembraneNeckPhase(firstHalfNeck, secondHalfNeck, firstMaxHalfNeck, secondMaxHalfNeck) {
  const maxHalfNeck = Math.max(0.5, Math.min(firstMaxHalfNeck, secondMaxHalfNeck));
  const averageHalfNeck = (firstHalfNeck + secondHalfNeck) / 2;
  return clamp01(1 - (averageHalfNeck / maxHalfNeck));
}

function resolveMembraneNeckInner(halfNeck, neckPhase) {
  return Math.max(0.35, halfNeck * (1 - (neckPhase * 0.93)));
}

function resolveMembraneCurveTension(gap, neckPhase) {
  return Math.max(6, Math.max(0.5, gap) * (0.26 + (neckPhase * 0.18)));
}

function resolveElementRadius(element, fallback = 16) {
  if (!element || !element.isConnected) return fallback;

  const style = getComputedStyle(element);
  const candidates = [
    parseFloat(style.borderTopLeftRadius),
    parseFloat(style.borderTopRightRadius),
    parseFloat(style.borderBottomRightRadius),
    parseFloat(style.borderBottomLeftRadius)
  ].filter(Number.isFinite);

  if (!candidates.length) return fallback;
  return Math.max(...candidates);
}

function resolveMitosisParent(island, parent = null) {
  if (parent) return parent;
  return island?.shadowRoot?.getElementById('hover-zone') || null;
}

const FULL_DIVISION_STORE_PROP = '_fullDivisionInstances';
let divisionAnimatorModulePromise = null;

function ensureFullDivisionStore(owner, property = FULL_DIVISION_STORE_PROP) {
  if (!owner) return null;
  if (!(owner[property] instanceof Map)) {
    owner[property] = new Map();
  }
  return owner[property];
}

function getFullDivisionInstance(owner, id, property = FULL_DIVISION_STORE_PROP) {
  if (!owner || !id) return null;
  const store = owner[property];
  if (!(store instanceof Map)) return null;
  return store.get(id) || null;
}

function setFullDivisionInstance(owner, id, division, property = FULL_DIVISION_STORE_PROP) {
  if (!owner || !id || !division) return;
  const store = ensureFullDivisionStore(owner, property);
  if (!store) return;
  store.set(id, division);
}

function deleteFullDivisionInstance(owner, id, property = FULL_DIVISION_STORE_PROP) {
  if (!owner || !id) return;
  const store = owner[property];
  if (!(store instanceof Map)) return;
  store.delete(id);
}

function resolveFullDivisionParent(island, parent = null) {
  if (parent) return parent;
  return island?.shadowRoot?.getElementById('bar-container') || null;
}

async function resolveDivisionAnimatorClass(options = {}) {
  if (typeof options.DivisionAnimatorClass === 'function') {
    return options.DivisionAnimatorClass;
  }

  if (!divisionAnimatorModulePromise) {
    divisionAnimatorModulePromise = import('/static/js/features/animations/DivisionAnimator.js');
  }

  const mod = await divisionAnimatorModulePromise;
  return mod?.DivisionAnimator || mod?.default || null;
}

AnimationEngine.registerMitosisStrategy('pill-open', ({ engine, context, options }) => {
  const island = context.island;
  const parent = resolveMitosisParent(island, options.parent);
  if (!island || !parent) return null;

  const splitClass = options.splitClass === undefined
    ? `split-${options.direction || 'right'}`
    : options.splitClass;

  const pill = engine.createMitosis(island, {
    parent,
    insert: options.insert || 'prepend',
    containerId: options.containerId || 'mitosis-pill',
    className: options.className || 'mitosis-pill',
    containerHTML: options.containerHTML || '',
    cssVars: options.cssVars || {},
    startAnimation: '',
    useDefaultIslandStyle: false,
    owner: island,
    timerProperty: options.timerProperty || '_animationTimers'
  });

  if (typeof options.onCreate === 'function') {
    options.onCreate(pill);
  }

  engine.runSequence(island, [
    {
      frames: Number.isFinite(options.enterFrames) ? options.enterFrames : 2,
      run: () => {
        if (splitClass) {
          pill.classList.add(splitClass);
        }

        if (typeof options.onEnter === 'function') {
          options.onEnter(pill);
        }
      }
    }
  ], {
    context: { island, pill },
    timerProperty: options.timerProperty || '_animationTimers'
  });

  return pill;
});

AnimationEngine.registerMitosisStrategy('pill-close', ({ engine, context, options }) => {
  const island = context.island;
  if (!island || !island.shadowRoot) return [];

  const selector = options.selector || (options.id ? `#mitosis-${options.id}` : '.mitosis-pill');
  const pills = Array.isArray(options.pills)
    ? options.pills.filter(Boolean)
    : Array.from(island.shadowRoot.querySelectorAll(selector));

  pills.forEach((pill) => {
    const impactRect = pill.getBoundingClientRect();

    if (options.removeHoverTargets !== false) {
      pill.querySelectorAll('.hover-target').forEach((target) => target.classList.remove('hover-target'));
    }

    if (typeof options.beforeClose === 'function') {
      options.beforeClose(pill);
    }

    if (typeof options.collapseClassName === 'string') {
      pill.className = options.collapseClassName;
    }

    const impactOptions = typeof options.getImpactOptions === 'function'
      ? options.getImpactOptions({ pill, impactRect, island })
      : options.impactOptions;

    engine.destroyMitosis(pill, {
      owner: island,
      timerProperty: options.timerProperty || '_animationTimers',
      waitForTransition: true,
      duration: Number.isFinite(options.removalDelay) ? options.removalDelay : 600,
      onComplete: () => {
        if (impactOptions && island.respondToImpact) {
          island.respondToImpact(impactOptions);
        }

        if (typeof options.onComplete === 'function') {
          options.onComplete(pill);
        }
      }
    });
  });

  return pills;
});

AnimationEngine.registerMitosisStrategy('division-lite-open', ({ engine, context, options }) => {
  const island = context.island;
  const owner = context.owner || island;
  const timerProperty = options.timerProperty || '_animationTimers';
  const parent = resolveMitosisParent(island, options.parent);

  if (!island || !owner || !parent) return null;

  engine.clearScheduled(owner, timerProperty);

  (options.staleIds || []).forEach((id) => {
    const staleNode = island.shadowRoot?.getElementById(id) || null;
    if (staleNode) {
      engine.destroyMitosis(staleNode, { duration: 0, endAnimation: '' });
    }
  });

  if (options.preImpactOptions && island.respondToImpact) {
    island.respondToImpact(options.preImpactOptions);
  }

  const splitClass = options.splitClass === undefined
    ? `split-${options.direction || 'down'}`
    : options.splitClass;

  const pill = engine.createMitosis(island, {
    parent,
    insert: options.insert || 'prepend',
    containerId: options.containerId || 'mitosis-division-lite',
    className: options.className || 'mitosis-pill',
    containerHTML: options.containerHTML || '',
    cssVars: options.cssVars || {},
    startAnimation: '',
    useDefaultIslandStyle: false,
    owner,
    timerProperty
  });

  const isActive = () => {
    if (!pill || !pill.parentNode) return false;
    if (typeof options.isActive === 'function') return options.isActive(pill);
    return true;
  };

  if (typeof options.onCreate === 'function') {
    options.onCreate(pill);
  }

  engine.runSequence(owner, [
    {
      frames: Number.isFinite(options.budFrames) ? options.budFrames : 1,
      run: () => {
        if (!isActive()) return;
        if (typeof options.onBud === 'function') options.onBud(pill);
      }
    },
    {
      delay: Number.isFinite(options.pinchDelayMs) ? options.pinchDelayMs : 24,
      run: () => {
        if (!isActive()) return;
        if (typeof options.onPinch === 'function') options.onPinch(pill);
      }
    },
    {
      delay: Number.isFinite(options.growDelayMs) ? options.growDelayMs : 18,
      run: () => {
        if (!isActive()) return;
        if (splitClass) pill.classList.add(splitClass);
        if (typeof options.onGrow === 'function') options.onGrow(pill);
      }
    },
    {
      delay: Number.isFinite(options.revealDelayMs) ? options.revealDelayMs : 120,
      run: () => {
        if (!isActive()) return;
        if (typeof options.onReveal === 'function') options.onReveal(pill);
      }
    }
  ], {
    context: { island, owner, pill },
    timerProperty
  });

  engine.afterTransitionOrTimeout(owner, pill, {
    propertyName: options.settlePropertyName || null,
    timeoutMs: Number.isFinite(options.settleTimeoutMs) ? options.settleTimeoutMs : 820,
    timerProperty,
    callback: () => {
      if (!isActive()) return;
      if (typeof options.onSettled === 'function') options.onSettled(pill);
    }
  });

  if (typeof options.onCursorReset === 'function') {
    options.onCursorReset();
  }

  return pill;
});

AnimationEngine.registerMitosisStrategy('division-lite-close', ({ engine, context, options }) => {
  const island = context.island;
  const owner = context.owner || island;
  const timerProperty = options.timerProperty || '_animationTimers';
  const pill = options.pill || island?.shadowRoot?.getElementById(options.containerId || 'mitosis-division-lite');

  if (!island || !owner || !pill) return null;

  const isActive = () => {
    if (!pill || !pill.parentNode) return false;
    if (typeof options.isActive === 'function') return options.isActive(pill);
    return true;
  };

  if (typeof options.onStart === 'function') {
    options.onStart(pill);
  }

  engine.runSequence(owner, [
    {
      delay: Number.isFinite(options.shrinkDelayMs) ? options.shrinkDelayMs : 20,
      run: () => {
        if (!isActive()) return;
        if (typeof options.onShrink === 'function') options.onShrink(pill);
      }
    },
    {
      delay: Number.isFinite(options.absorbDelayMs) ? options.absorbDelayMs : 80,
      run: () => {
        if (!isActive()) return;
        if (typeof options.onAbsorb === 'function') options.onAbsorb(pill);

        engine.runMitosisStrategy('pill-close', { island }, {
          pills: [pill],
          collapseClassName: options.collapseClassName,
          removalDelay: Number.isFinite(options.removalDelay) ? options.removalDelay : 340,
          timerProperty,
          getImpactOptions: options.getImpactOptions,
          impactOptions: options.impactOptions,
          removeHoverTargets: options.removeHoverTargets,
          onComplete: options.onComplete
        });
      }
    }
  ], {
    context: { island, owner, pill },
    timerProperty
  });

  if (typeof options.onCursorReset === 'function') {
    options.onCursorReset();
  }

  return pill;
});

AnimationEngine.registerMitosisStrategy('division-full-open', ({ context, options }) => (async () => {
  const island = context.island || options.island || null;
  const owner = context.owner || options.owner || island;
  const parent = resolveFullDivisionParent(island, options.parent);
  const id = options.id || options.containerId || null;
  const storeProperty = options.storeProperty || FULL_DIVISION_STORE_PROP;

  if (!owner || !parent) return null;

  const DivisionAnimatorClass = await resolveDivisionAnimatorClass(options);
  if (typeof DivisionAnimatorClass !== 'function') {
    console.warn('AnimationEngine.division-full-open: DivisionAnimator is unavailable');
    return null;
  }

  let child = options.child || null;
  if (!child && typeof options.createChild === 'function') {
    child = options.createChild();
  }

  if (!child) {
    console.warn('AnimationEngine.division-full-open: child element is required');
    return null;
  }

  const previous = id ? getFullDivisionInstance(owner, id, storeProperty) : null;
  if (previous && previous !== options.division) {
    previous.abort?.();
    if (options.removePreviousChild !== false && previous._child?.parentNode) {
      previous._child.remove();
    }
    deleteFullDivisionInstance(owner, id, storeProperty);
  }

  let division = null;
  const onRemoved = (payload) => {
    if (id) {
      const current = getFullDivisionInstance(owner, id, storeProperty);
      if (current === division) {
        deleteFullDivisionInstance(owner, id, storeProperty);
      }
    }

    if (typeof options.onRemoved === 'function') {
      options.onRemoved(payload);
    }
  };

  division = new DivisionAnimatorClass({
    parent,
    child,
    target: options.target || null,
    direction: options.direction || 'down',
    shellTarget: options.shellTarget || island || parent,
    shellAttribute: options.shellAttribute,
    budSize: options.budSize,
    budOverlap: options.budOverlap,
    budDuration: options.budDuration,
    pinchGap: options.pinchGap,
    pinchWidth: options.pinchWidth,
    pinchDuration: options.pinchDuration,
    splitDuration: options.splitDuration,
    membrane: options.membrane,
    squashChild: options.squashChild,
    childZIndex: options.childZIndex,
    onPhase: options.onPhase,
    onSettled: options.onSettled,
    onRemoved,
    owner,
    membraneOptions: options.membraneOptions || {}
  });

  if (id) {
    setFullDivisionInstance(owner, id, division, storeProperty);
  }

  if (options.startPhase) {
    division._phase = options.startPhase;
  }

  if (options.preImpactOptions && island?.respondToImpact) {
    island.respondToImpact(options.preImpactOptions);
  }

  if (options.autoRun !== false) {
    await division.divide();
  }

  return division;
})());

AnimationEngine.registerMitosisStrategy('division-full-close', ({ engine, context, options }) => (async () => {
  const island = context.island || options.island || null;
  const owner = context.owner || options.owner || island;
  const id = options.id || options.containerId || null;
  const storeProperty = options.storeProperty || FULL_DIVISION_STORE_PROP;

  if (!owner) return null;

  let division = options.division || null;
  if (!division && id) {
    division = getFullDivisionInstance(owner, id, storeProperty);
  }

  if (!division && options.createIfMissing) {
    division = await engine.runMitosisStrategy('division-full-open', {
      island,
      owner
    }, {
      ...options.createIfMissing,
      id,
      storeProperty,
      autoRun: false,
      startPhase: options.createIfMissing.startPhase || 'settled'
    });
  }

  if (!division) return null;

  if (typeof options.onStart === 'function') {
    options.onStart(division);
  }

  if (options.forceSettled === true && division.phase !== 'settled') {
    division._phase = 'settled';
  }

  if (division.phase !== 'settled') {
    if (options.forceAbortRemove === true) {
      const child = options.child || division._child || null;
      division.abort?.();
      if (child?.parentNode) child.remove();
      if (id) deleteFullDivisionInstance(owner, id, storeProperty);

      if (typeof options.onForceRemoved === 'function') {
        options.onForceRemoved({ division, child });
      }
    }

    return division;
  }

  await division.absorb();

  if (typeof options.onComplete === 'function') {
    options.onComplete(division);
  }

  return division;
})());

AnimationEngine.registerMitosisStrategy('search-open', ({ engine, context, options }) => {
  const island = context.island;
  if (!island) return null;

  const pill = engine.runMitosisStrategy('division-lite-open', { island }, {
    owner: island,
    parent: options.parent,
    containerId: 'mitosis-search',
    className: 'mitosis-pill',
    containerHTML: options.containerHTML || '',
    cssVars: {
      '--mitosis-distance': `${options.searchDrop}px`
    },
    splitClass: 'split-down',
    direction: 'down',
    onCreate: options.onCreate,
    onGrow: options.onEnter,
    timerProperty: options.timerProperty || '_animationTimers'
  });

  if (!pill) return null;

  engine.runSequence(island, [
    {
      delay: Number.isFinite(options.expandDelay) ? options.expandDelay : 520,
      run: () => {
        pill.classList.add('search-expanded');

        if (typeof options.onExpanded === 'function') {
          options.onExpanded(pill);
        }
      }
    },
    {
      delay: Number.isFinite(options.focusDelay) ? options.focusDelay : 350,
      run: () => {
        if (typeof options.focus === 'function') {
          options.focus(pill);
          return;
        }

        const input = pill.querySelector('#search-input');
        if (input) input.focus();
      }
    }
  ], {
    context: { island, pill },
    timerProperty: options.timerProperty || '_animationTimers'
  });

  return pill;
});

AnimationEngine.registerMitosisStrategy('search-close', ({ engine, context, options }) => {
  const island = context.island;
  const pill = options.pill || island?.shadowRoot?.getElementById('mitosis-search');
  if (!island || !pill) return null;

  return engine.runMitosisStrategy('division-lite-close', { island }, {
    owner: island,
    pill,
    onStart: options.onStart,
    onShrink: () => {
      pill.classList.remove('search-expanded');
    },
    absorbDelayMs: Number.isFinite(options.collapseDelay) ? options.collapseDelay : 520,
    collapseClassName: 'mitosis-pill',
    removalDelay: Number.isFinite(options.removalDelay) ? options.removalDelay : 600,
    timerProperty: options.timerProperty || '_animationTimers',
    getImpactOptions: options.getImpactOptions,
    impactOptions: options.impactOptions,
    removeHoverTargets: options.removeHoverTargets
  });
});

export default AnimationEngine;
