const express = require('express')
const router = express.Router()
const { runSearch } = require('../services/searchQuery')

// 标题栏「全局搜索」：这里只做 HTTP 形状，查询与分页全部在 services/searchQuery.js。
router.get('/', (req, res) => {
  try {
    res.json(runSearch(req.query))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
