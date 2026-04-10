// static/js/AnimationEngine.js
// Motor genérico de animações (Mitosis + Morph) reutilizável

export class AnimationEngine {
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
   * Executa uma animação de Mitose (expansão do componente)
   * @param {HTMLElement} island - Elemento da ilha
   * @param {Object} options - Configurações
   *   - containerHTML: string com HTML a render
   *   - startAnimation: nome da keyframe inicial
   *   - onComplete: callback quando animação termina
   *   - duration: duração em ms (padrão 850)
   * @returns {HTMLElement} - Elemento do container criado
   */
  static createMitosis(island, options = {}) {
    const {
      containerHTML = '',
      startAnimation = 'cellularExpansion',
      onComplete = null,
      duration = 850,
      containerId = 'mitosis-container',
      initialStyle = null
    } = options;

    const container = document.createElement('div');
    container.id = containerId;
    container.innerHTML = containerHTML;

    const animDecl = `animation: ${startAnimation} ${duration}ms linear both;`;

    if (initialStyle) {
      container.style.cssText = `${initialStyle}; ${animDecl}`;
    } else {
      container.style.cssText = `
        position: fixed;
        top: 15px;
        left: 50%;
        transform: translateX(-50%) scale(0.08);
        width: 38px;
        height: 38px;
        z-index: 996;
        border-radius: var(--radius-dynamic-island);
        pointer-events: auto;
        ${animDecl}
      `;
    }

    document.body.appendChild(container);

    if (onComplete) {
      setTimeout(onComplete, duration);
    }

    return container;
  }

  /**
   * Executa uma animação de Contração (mitose reversa)
   * @param {HTMLElement} container - Elemento a contrair
   * @param {Object} options - Configurações
   *   - endAnimation: nome da keyframe final
   *   - onComplete: callback ao terminar
   *   - duration: duração em ms (padrão 850)
   */
  static destroyMitosis(container, options = {}) {
    if (!container) return;

    const {
      endAnimation = 'cellularContraction',
      onComplete = null,
      duration = 850
    } = options;

    container.style.animation = `${endAnimation} ${duration}ms linear both`;

    setTimeout(() => {
      if (container.parentNode) {
        container.remove();
      }
      if (onComplete) onComplete();
    }, duration);
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
  static reset(island) {
    if (!island || !island.reset) {
      console.warn('AnimationEngine.reset: RolfsoundIsland not properly configured');
      return;
    }
    island.reset();
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
   * Delegação para RolfsoundIsland.mitosis() com validação
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {Object} options - { id, icon, eventName, direction, distance }
   */
  static mitosis(island, options = {}) {
    if (!island || !island.mitosis) {
      console.warn('AnimationEngine.mitosis: RolfsoundIsland not properly configured');
      return;
    }
    island.mitosis(options);
  }

  /**
   * Desfaz mitose de botão (retrai o controle para a ilha)
   * Delegação para RolfsoundIsland.undoMitosis() com validação
   * @param {HTMLElement} island - Elemento RolfsoundIsland
   * @param {string} id - ID do botão de mitose a remover
   */
  static undoMitosis(island, id) {
    if (!island || !island.undoMitosis) {
      console.warn('AnimationEngine.undoMitosis: RolfsoundIsland not properly configured');
      return;
    }
    island.undoMitosis(id);
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
  static hideNotification(island) {
    if (!island || !island.hideNotification) {
      console.warn('AnimationEngine.hideNotification: RolfsoundIsland not properly configured');
      return;
    }
    island.hideNotification();
  }
}

export default AnimationEngine;
