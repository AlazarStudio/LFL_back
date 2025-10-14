import asyncHandler from 'express-async-handler'

import { prisma } from '../prisma.js'


// @desc    Get _emptys
// @route   GET /api/_emptys
// @access  Private
export const get_Emptys = asyncHandler(async (req, res) => {
	const _emptys = await prisma._empty.findMany({
		orderBy: {
			createdAt: 'desc'
		}
	})
	res.json(_emptys)
})


// @desc    Get _empty
// @route   GET /api/_emptys/:id
// @access  Private
export const get_Empty = asyncHandler(async (req, res) => {
	const _empty = await prisma._empty.findUnique({
		where: { id: +req.params.id }
	})

	if (!_empty) {
		res.status(404)
		throw new Error('_Empty not found!')
	}

	res.json({ ..._empty })
})


// @desc    Create new _empty
// @route 	POST /api/_emptys
// @access  Private
export const createNew_Empty = asyncHandler(async (req, res) => {
	const {  } = req.body

	const _empty = await prisma._empty.create({
		data: {
			
		}
	})

	res.json(_empty)
})


// @desc    Update _empty
// @route 	PUT /api/_emptys/:id
// @access  Private
export const update_Empty = asyncHandler(async (req, res) => {
	const {  } = req.body

	try {
		const _empty = await prisma._empty.update({
			where: {
				id: +req.params.id
			},
			data: {
				
			}
		})

		res.json(_empty)
	} catch (error) {
		res.status(404)
		throw new Error('_Empty not found!')
	}
})


// @desc    Delete _empty
// @route 	DELETE /api/_emptys/:id
// @access  Private
export const delete_Empty = asyncHandler(async (req, res) => {
	try {
		const _empty = await prisma._empty.delete({
			where: {
				id: +req.params.id
			}
		})

		res.json({ message: '_Empty deleted!' })
	} catch (error) {
		res.status(404)
		throw new Error('_Empty not found!')
	}
})
