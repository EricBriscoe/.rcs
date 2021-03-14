export ZSH="$HOME/.rcs/ohmyzsh"
ZSH_THEME="../../powerlevel10k/powerlevel10k"
plugins=(git vi-mode)

VI_MODE_SET_CURSOR=true

source $ZSH/oh-my-zsh.sh

alias tmux='tmux -2'

function sv() {
    source venv/bin/activate &&
    tmux set-environment VIRTUAL_ENV $VIRTUAL_ENV
}
if [ -n "$VIRTUAL_ENV" ]; then
    source $VIRTUAL_ENV/bin/activate;
fi

mkcdir ()
{
    mkdir -p -- "$1" &&
      cd -P -- "$1"
}
