// static/js/Cursor.js

export default class Cursor {
  constructor() {
    this.dot = document.getElementById('cursor-dot');
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    
    this.speedFree = 0.75;    
    this.speedMagnetic = 0.2; 
    
    this.isHovering = false;
    this.isContextRing = false;
    this.isContextMorphing = false;
    this.currentTarget = null;
    this.targetRect = null; 
    this.contextMorphTimer = null;
    
    this.init();
  }

  init() {
    if (!this.dot) return;

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.checkHoverState(e);
    });

    // Cursor sai da janela do browser → força reset para não ficar travado
    document.addEventListener('mouseleave', () => this.resetHover());

    window.addEventListener('scroll', () => {
      if (this.isHovering && this.currentTarget && this.currentTarget.isConnected) {
        this.targetRect = this.currentTarget.getBoundingClientRect();
      }
    }, { capture: true, passive: true });

    window.addEventListener('rolfsound-context-open', (e) => {
      const x = e.detail?.x;
      const y = e.detail?.y;
      this.startContextMorph(x, y);
    });

    window.addEventListener('rolfsound-context-close', () => {
      this.stopContextMorph();
    });

    this.render();
  }

  // ─── FUNÇÃO NOVA: Limpa o estado do cursor com segurança ───
  resetHover() {
    this.isHovering = false;
    this.currentTarget = null;
    this.targetRect = null;
    this.dot.classList.remove('hovering');

    this.dot.style.width = '5px';
    this.dot.style.height = '5px';
    this.dot.style.borderRadius = '50%';
    this.dot.style.border = '0';
    this.dot.style.backgroundColor = '';
    
    this.dot.style.setProperty('--dx', '0px');
    this.dot.style.setProperty('--dy', '0px');
  }

  setContextRing() {
    if (this.isContextRing) return;
    this.isContextRing = true;
    this.dot.classList.remove('hovering');
    this.dot.classList.add('context-ring');
    this.dot.style.setProperty('--dx', '0px');
    this.dot.style.setProperty('--dy', '0px');
  }

  clearContextRing() {
    if (!this.isContextRing) return;
    this.isContextRing = false;
    this.dot.classList.remove('context-ring');
    this.dot.style.border = '0';
    this.dot.style.backgroundColor = '';
  }

  checkHoverState(e) {
    if (this.isContextMorphing) return;

    // Valida se o elemento ainda existe e tem a classe
    if (this.currentTarget && (!this.currentTarget.isConnected || !this.currentTarget.classList.contains('hover-target'))) {
      this.resetHover();
    }

    const path = e.composedPath();
    const target = path.find(el => el.classList && el.classList.contains('hover-target'));
    const insideContextMenu = path.find(el => el.classList && el.classList.contains('rs-context-menu'));

    if (target) {
      this.clearContextRing();

      if (this.currentTarget !== target) {
        this.currentTarget = target;
        this.isHovering = true;
        this.dot.classList.add('hovering');

        // Calcula tamanho APENAS UMA VEZ (pois o botão não cresce/encolhe)
        this.targetRect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);

        this.dot.style.width = `${this.targetRect.width}px`;
        this.dot.style.height = `${this.targetRect.height}px`;
        this.dot.style.borderRadius = style.borderRadius;
      }
    } else if (insideContextMenu) {
      if (this.isHovering) this.resetHover();
      this.setContextRing();
    } else if (this.isHovering) {
      this.clearContextRing();
      this.resetHover();
    } else {
      this.clearContextRing();
    }
  }

  startContextMorph(x, y) {
    if (!this.dot) return;

    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.mouse.x = x;
      this.mouse.y = y;
      this.pos.x = x;
      this.pos.y = y;
    }

    if (this.contextMorphTimer) {
      clearTimeout(this.contextMorphTimer);
      this.contextMorphTimer = null;
    }

    this.clearContextRing();
    this.resetHover();

    this.isContextMorphing = true;
    this.dot.classList.add('context-morphing');

    this.contextMorphTimer = setTimeout(() => {
      this.dot.classList.remove('context-morphing');
      this.isContextMorphing = false;
      this.contextMorphTimer = null;
    }, 220);
  }

  stopContextMorph() {
    if (!this.dot) return;

    if (this.contextMorphTimer) {
      clearTimeout(this.contextMorphTimer);
      this.contextMorphTimer = null;
    }

    this.isContextMorphing = false;
    this.dot.classList.remove('context-morphing');
  }

  render() {
    let targetX, targetY, currentSpeed;

    if (this.isContextMorphing) {
      targetX = this.pos.x;
      targetY = this.pos.y;
      currentSpeed = 1;
    } else if (this.isHovering && this.currentTarget) {
      // ─── A CORREÇÃO DO BUG DA MITOSE ESTÁ AQUI ───
      // Se o botão for deletado do DOM OU perder a classe hover-target, solta o cursor imediatamente!
      if (!this.currentTarget.isConnected || !this.currentTarget.classList.contains('hover-target')) {
        this.resetHover();
        
        // Redireciona o alvo imediatamente para o mouse livre para não engasgar
        targetX = this.mouse.x;
        targetY = this.mouse.y;
        currentSpeed = this.speedFree;
      } else {
        // Atualiza posição E tamanho em TEMPO REAL para acompanhar animações CSS
        this.targetRect = this.currentTarget.getBoundingClientRect();

        targetX = this.targetRect.left + this.targetRect.width / 2;
        targetY = this.targetRect.top + this.targetRect.height / 2;

        this.dot.style.width  = `${this.targetRect.width}px`;
        this.dot.style.height = `${this.targetRect.height}px`;

        const dx = (this.mouse.x - targetX) * 0.4;
        const dy = (this.mouse.y - targetY) * 0.4;

        this.dot.style.setProperty('--dx', `${dx}px`);
        this.dot.style.setProperty('--dy', `${dy}px`);
        
        currentSpeed = this.speedMagnetic;
      }
    } else {
      targetX = this.mouse.x;
      targetY = this.mouse.y;
      currentSpeed = this.speedFree;
    }

    this.pos.x += (targetX - this.pos.x) * currentSpeed;
    this.pos.y += (targetY - this.pos.y) * currentSpeed;

    // Usando translate3d força a renderização via Hardware (GPU)
    this.dot.style.transform = `translate3d(calc(${this.pos.x}px - 50%), calc(${this.pos.y}px - 50%), 0)`;
    
    requestAnimationFrame(this.render.bind(this));
  }
}