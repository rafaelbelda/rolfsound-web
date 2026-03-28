// static/js/Cursor.js

export default class Cursor {
  constructor() {
    this.dot = document.getElementById('cursor-dot');
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    
    // ─── O SEGREDO DO FEELING PREMIUM: Múltiplas Velocidades ───
    this.speedFree = 0.75;     // Livre: Muito rápido, responsivo, elimina o lag
    this.speedMagnetic = 0.2;  // No botão: Inércia pesada para o efeito "chiclete"
    
    this.isHovering = false;
    this.currentTarget = null;
    
    this.init();
  }

  init() {
    if (!this.dot) return;

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.checkHoverState(e);
    });

    this.render();
  }

  checkHoverState(e) {
    const path = e.composedPath();
    const target = path.find(el => el.classList && el.classList.contains('hover-target'));

    if (target) {
      if (this.currentTarget !== target) {
        this.currentTarget = target;
        this.isHovering = true;
        this.dot.classList.add('hovering');

        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);

        // A pílula assume a exata forma geométrica do botão alvo
        this.dot.style.width = `${rect.width}px`;
        this.dot.style.height = `${rect.height}px`;
        this.dot.style.borderRadius = style.borderRadius;
      }
    } else if (this.isHovering) {
      this.isHovering = false;
      this.currentTarget = null;
      this.dot.classList.remove('hovering');

      // Volta a ser a bolinha ágil
      this.dot.style.width = '5px';
      this.dot.style.height = '5px';
      this.dot.style.borderRadius = '50%';
      
      this.dot.style.setProperty('--dx', '0px');
      this.dot.style.setProperty('--dy', '0px');
    }
  }

  render() {
    let targetX, targetY, currentSpeed;

    if (this.isHovering && this.currentTarget) {
      // 1. A PÍLULA foca no centro geométrico do botão
      const rect = this.currentTarget.getBoundingClientRect();
      targetX = rect.left + rect.width / 2;
      targetY = rect.top + rect.height / 2;

      // 2. A BOLINHA INTERNA compensa a distância instantaneamente (sem lag)
      // O fator 0.4 impede que a bolinha vaze para fora da pílula
      const dx = (this.mouse.x - targetX) * 0.4;
      const dy = (this.mouse.y - targetY) * 0.4;

      this.dot.style.setProperty('--dx', `${dx}px`);
      this.dot.style.setProperty('--dy', `${dy}px`);
      
      // Usa a velocidade pegajosa para a pílula balançar
      currentSpeed = this.speedMagnetic;
    } else {
      // Fora dos botões, o cursor segue o mouse diretamente
      targetX = this.mouse.x;
      targetY = this.mouse.y;
      
      // Usa a velocidade super rápida para evitar a sensação de travamento
      currentSpeed = this.speedFree;
    }

    // Aplica a matemática do Lerp dinâmico
    this.pos.x += (targetX - this.pos.x) * currentSpeed;
    this.pos.y += (targetY - this.pos.y) * currentSpeed;

    this.dot.style.transform = `translate3d(calc(${this.pos.x}px - 50%), calc(${this.pos.y}px - 50%), 0)`;
    
    requestAnimationFrame(this.render.bind(this));
  }
}