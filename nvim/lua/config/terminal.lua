local M = {}

local state = {
  buf = nil,
  win = nil,
}

local function open_float(buf)
  local width = math.floor(vim.o.columns * 0.85)
  local height = math.floor(vim.o.lines * 0.8)
  local row = math.floor((vim.o.lines - height) / 2)
  local col = math.floor((vim.o.columns - width) / 2)

  return vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = width,
    height = height,
    row = row,
    col = col,
    style = "minimal",
    border = "rounded",
    title = " terminal ",
    title_pos = "center",
  })
end

function M.toggle()
  if state.win and vim.api.nvim_win_is_valid(state.win) then
    vim.api.nvim_win_hide(state.win)
    state.win = nil
    return
  end

  if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
    state.win = open_float(state.buf)
    vim.cmd.startinsert()
    return
  end

  state.buf = vim.api.nvim_create_buf(false, true)
  state.win = open_float(state.buf)
  vim.cmd.terminal()
  vim.cmd.startinsert()
end

vim.api.nvim_create_autocmd("TermOpen", {
  callback = function()
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.signcolumn = "no"
  end,
})

vim.api.nvim_create_autocmd("TermClose", {
  callback = function(args)
    if args.buf == state.buf then
      state.buf = nil
      state.win = nil
      vim.schedule(function()
        if vim.api.nvim_buf_is_valid(args.buf) then
          vim.api.nvim_buf_delete(args.buf, { force = true })
        end
      end)
    end
  end,
})

local function map(mode, lhs)
  vim.keymap.set(mode, lhs, function()
    M.toggle()
  end, { desc = "Toggle terminal", silent = true })
end

map({ "n", "t" }, "<C-/>")
map({ "n", "t" }, "<C-_>")
map("n", "<leader>tt")

return M
