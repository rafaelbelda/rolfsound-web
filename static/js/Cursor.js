// static/js/Cursor.js

export default class Cursor {
  constructor() {
    this.dot = document.getElementById('cursor-dot');
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    
    this.speedFree = 0.75;    
    this.speedMagnetic = 0.2; 
    
    this.isHovering = false;
    this.currentTarget = null;
    this.targetRect = null; 
    
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
    
    this.dot.style.setProperty('--dx', '0px');
    this.dot.style.setProperty('--dy', '0px');
  }

  checkHoverState(e) {
    // Valida se o elemento ainda existe e tem a classe
    if (this.currentTarget && (!this.currentTarget.isConnected || !this.currentTarget.classList.contains('hover-target'))) {
      this.resetHover();
    }

    const path = e.composedPath();
    const target = path.find(el => el.classList && el.classList.contains('hover-target'));

    if (target) {
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
    } else if (this.isHovering) {
      this.resetHover();
    }
  }

  render() {
    let targetX, targetY, currentSpeed;

    if (this.isHovering && this.currentTarget) {
      // ─── A CORREÇÃO DO BUG DA MITOSE ESTÁ AQUI ───
      // Se o botão for deletado do DOM OU perder a classe hover-target, solta o cursor imediatamente!
      if (!this.currentTarget.isConnected || !this.currentTarget.classList.contains('hover-target')) {
        this.resetHover();
        
        // Redireciona o alvo imediatamente para o mouse livre para não engasgar
        targetX = this.mouse.x;
        targetY = this.mouse.y;
        currentSpeed = this.speedFree;
      } else {
        // Atualiza a posição em TEMPO REAL para acompanhar animações CSS
        this.targetRect = this.currentTarget.getBoundingClientRect();

        targetX = this.targetRect.left + this.targetRect.width / 2;
        targetY = this.targetRect.top + this.targetRect.height / 2;

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